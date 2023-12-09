export default async function chorusChartDb() {
  const root = await navigator.storage.getDirectory();

  const localDataVersion = localStorage.getItem('chartsDataVersion');
  const serverDataVersion = await getServerChartsDataVersion();

  if (localDataVersion !== serverDataVersion) {
    root.removeEntry('serverData', {recursive: true});
    localStorage.setItem('chartsDataVersion', serverDataVersion);
  }

  const serverDataHandle = await root.getDirectoryHandle('serverData', {
    create: true,
  });

  const {serverCharts, serverMetadata} =
    await getServerCharts(serverDataHandle);

  console.log(serverCharts, serverMetadata);
}

async function fetchServerData(
  chartsHandle: FileSystemFileHandle,
  metadataHandle: FileSystemFileHandle,
) {
  const results = await Promise.all([
    fetch('/data/charts.json'),
    fetch('/data/metadata.json'),
  ]);

  const [charts, metadata] = await Promise.all(results.map(r => r.json()));

  await Promise.all([
    writeFile(chartsHandle, JSON.stringify(charts)),
    writeFile(metadataHandle, JSON.stringify(metadata)),
  ]);

  return {charts, metadata};
}

async function writeFile(fileHandle: FileSystemFileHandle, contents: string) {
  // Create a FileSystemWritableFileStream to write to.
  const writable = await fileHandle.createWritable();

  // Write the contents of the file to the stream.
  await writable.write(contents);

  // Close the file and write the contents to disk.
  await writable.close();
}

async function readJsonFile(fileHandle: FileSystemFileHandle) {
  const file = await fileHandle.getFile();
  const text = await file.text();
  return JSON.parse(text);
}

async function getServerChartsDataVersion() {
  const response = await fetch('/api/data');
  const json = await response.json();
  return json.chartsDataVersion;
}

async function getServerCharts(serverDataHandle: FileSystemDirectoryHandle) {
  let serverCharts;
  let serverMetadata;

  try {
    const serverChartsHandle = await serverDataHandle.getFileHandle(
      'charts.json',
      {
        create: false,
      },
    );
    serverCharts = await readJsonFile(serverChartsHandle);

    const serverMetadataHandle = await serverDataHandle.getFileHandle(
      'metadata.json',
      {
        create: false,
      },
    );
    serverMetadata = await readJsonFile(serverMetadataHandle);
  } catch {
    const serverChartsHandle = await serverDataHandle.getFileHandle(
      'charts.json',
      {
        create: true,
      },
    );
    const serverMetadataHandle = await serverDataHandle.getFileHandle(
      'metadata.json',
      {
        create: true,
      },
    );
    const {charts, metadata} = await fetchServerData(
      serverChartsHandle,
      serverMetadataHandle,
    );

    serverCharts = charts;
    serverMetadata = metadata;
  }

  return {serverCharts, serverMetadata};
}
