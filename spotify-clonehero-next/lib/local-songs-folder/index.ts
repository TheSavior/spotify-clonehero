import {set} from 'idb-keyval';
import filenamify from 'filenamify/browser';

import {writeFile} from '@/lib/fileSystemHelpers';
import scanLocalCharts, {SongAccumulator} from './scanLocalCharts';
import {SngStream} from 'parse-sng';

// Save chart
// Replace chart
// Scan folder
// Get installed charts
// Request song directory
// Refresh permissions
// Has permission
// Get last scanned timestamp

async function promptForSongsDirectory() {
  alert('Select your Songs directory');

  let handle;
  try {
    handle = await window.showDirectoryPicker({
      id: 'clone-hero-songs',
      mode: 'readwrite',
    });
  } catch (err) {
    throw new Error('User canceled picker', {
      cause: err,
    });
  }

  await set('songsDirectoryHandle', handle);

  return handle;
}

let currentSongDirectoryCache: FileSystemDirectoryHandle | undefined;

export async function getSongsDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
  // const handle: FileSystemDirectoryHandle | undefined = await get(
  //   'songsDirectoryHandle',
  // );

  if (currentSongDirectoryCache) {
    return currentSongDirectoryCache;
  }

  // if (handle == null) {
  const promptedHandle = await promptForSongsDirectory();
  currentSongDirectoryCache = promptedHandle;
  return promptedHandle;
  // }

  // const permissionState: PermissionState = await handle.queryPermission({
  //   mode: 'readwrite',
  // });

  // console.log('premissionStatus', permissionState);
  // if (permissionState === 'granted') {
  //   return handle;
  // } else if (permissionState === 'prompt') {
  //   await handle.requestPermission({mode: 'readwrite'});
  //   return handle;
  // } else {
  //   return await promptForSongsDirectory();
  // }
}

export async function setSongsDirectoryHandle(
  handle: FileSystemDirectoryHandle,
) {
  await set('songsDirectoryHandle', handle);
}

type InstalledChartsResponse = {
  lastScanned: Date;
  installedCharts: SongAccumulator[];
};

export async function scanForInstalledCharts(
  callbackPerSong: () => void = () => {},
): Promise<InstalledChartsResponse> {
  const root = await navigator.storage.getDirectory();

  const handle = await getSongsDirectoryHandle();

  const installedCharts: SongAccumulator[] = [];
  await scanLocalCharts(handle, installedCharts, callbackPerSong);

  const installedChartsCacheHandle = await root.getFileHandle(
    'installedCharts.json',
    {
      create: true,
    },
  );
  writeFile(installedChartsCacheHandle, JSON.stringify(installedCharts));
  const now = new Date();
  localStorage.setItem('lastScannedInstalledCharts', now.getTime().toString());
  return {
    lastScanned: now,
    installedCharts,
  };
}

async function getBackupDirectory() {
  const root = await navigator.storage.getDirectory();

  const backupDirHandle = await root.getDirectoryHandle('backups', {
    create: true,
  });

  return backupDirHandle;
}

export async function moveToFolder(
  handle: FileSystemFileHandle | FileSystemDirectoryHandle,
  toFolder: FileSystemDirectoryHandle,
) {
  if (handle.kind === 'file') {
    if (await fileExists(toFolder, handle.name)) {
      await toFolder.removeEntry(handle.name, {recursive: true});
    }
    const newFileHandle = await toFolder.getFileHandle(handle.name, {
      create: true,
    });
    const writableStream = await newFileHandle.createWritable();
    const readableStream = await handle.getFile();
    await readableStream.stream().pipeTo(writableStream);
    return newFileHandle;
  } else if (handle.kind === 'directory') {
    if (await fileExists(toFolder, handle.name)) {
      await toFolder.removeEntry(handle.name, {recursive: true});
    }

    const backupDirHandle = await toFolder.getDirectoryHandle(handle.name, {
      create: true,
    });

    for await (const entry of handle.values()) {
      await moveToFolder(entry, backupDirHandle);
    }

    return backupDirHandle;
  }

  throw new Error('Unknown handle type');
}

async function fileExists(
  parentHandle: FileSystemDirectoryHandle,
  name: string,
) {
  try {
    const checkHandle = await parentHandle.getDirectoryHandle(name, {
      create: false,
    });

    return true;
  } catch {
    // Can't get it without creating, doesn't exist.
    return false;
  }
}

export async function backupSong(
  songHandle: FileSystemFileHandle | FileSystemDirectoryHandle,
): Promise<{
  revert: () => Promise<void>;
  deleteBackup: () => Promise<void>;
}> {
  const backupRootDirHandle = await getBackupDirectory();

  const newHandle = await moveToFolder(songHandle, backupRootDirHandle);

  const result = {
    async revert() {
      // Ideally we'd move the backup back to the original location
      // but we aren't tracking the parent FileSystemDirectoryHandle
      // We'll just move it back to Songs, sadly.
      const songsHandle = await getSongsDirectoryHandle();
      await moveToFolder(newHandle, songsHandle);
      // @ts-expect-error This API exists in Chrome, and we unfortunately rely on it
      await newHandle.remove({recursive: true});
    },
    async deleteBackup() {
      // @ts-expect-error This API exists in Chrome, and we unfortunately rely on it
      await newHandle.remove({recursive: true});
    },
  };

  return result;
}

export async function downloadSong(
  artist: string,
  song: string,
  charter: string,
  url: string,
) {
  const handle = await getSongsDirectoryHandle();
  const response = await fetch(url, {
    headers: {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'sec-fetch-dest': 'empty',
    },
    referrerPolicy: 'no-referrer',
    body: null,
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
  });

  const body = response.body;
  if (body == null) {
    return;
  }
  const artistSongTitle = `${artist} - ${song} (${charter})`;
  const filename = filenamify(artistSongTitle, {replacement: ''});

  await downloadAsFolder(handle, filename, body);
}

async function downloadAsFolder(
  folderHandle: FileSystemDirectoryHandle,
  filename: string,
  stream: ReadableStream,
) {
  // // Error if something matches the filename already
  let songDirHandle: FileSystemDirectoryHandle | undefined;
  try {
    songDirHandle = await folderHandle.getDirectoryHandle(filename, {
      create: false,
    });
  } catch {
    // This is what we hope for, that the file doesn't exist
  }
  if (songDirHandle != null) {
    throw new Error(`Chart ${filename} already installed`);
  }

  try {
    songDirHandle = await folderHandle.getDirectoryHandle(filename, {
      create: true,
    });
    await new Promise((resolve, reject) => {
      const sngStream = new SngStream(() => stream, {generateSongIni: true});
      sngStream.on('file', async (file, stream) => {
        const fileHandle = await songDirHandle!.getFileHandle(file, {
          create: true,
        });
        const writableStream = await fileHandle.createWritable();
        await stream.pipeTo(writableStream);
      });

      sngStream.on('end', () => {
        console.log(`Finished downloading ${filename}`);
        resolve('downloaded');
      });

      sngStream.on('error', error => {
        reject(error);
      });

      sngStream.start();
    });
  } catch (error) {
    console.error(error);
    await folderHandle.removeEntry(filename, {recursive: true});
    throw error;
  }
}

async function downloadAsSng(
  folderHandle: FileSystemDirectoryHandle,
  filename: string,
  stream: ReadableStream,
) {
  const fileWithExtension = `${filename}.sng`;

  // // Error if something matches the filename already
  let songFileHandle: FileSystemFileHandle | undefined;
  try {
    songFileHandle = await folderHandle.getFileHandle(fileWithExtension, {
      create: false,
    });
  } catch {
    // This is what we hope for, that the file doesn't exist
  }
  if (songFileHandle != null) {
    throw new Error(`Chart ${fileWithExtension} already installed`);
  }

  try {
    songFileHandle = await folderHandle.getFileHandle(fileWithExtension, {
      create: true,
    });
    const writableStream = await songFileHandle.createWritable();

    await stream.pipeTo(writableStream);
  } catch (error) {
    console.error(error);
    await folderHandle.removeEntry(fileWithExtension, {recursive: true});
    throw error;
  }
}
