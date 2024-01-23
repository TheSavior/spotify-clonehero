'use client';

import {useCallback, useEffect, useState} from 'react';
import {calculateTimes, parseChart} from '@/lib/preview/chart';
import {Highway} from './Highway';
import {
  downloadSong,
  emptyDirectory,
  getPreviewDownloadDirectory,
} from '@/lib/local-songs-folder';
import {Button} from '@/components/ui/button';
import {readTextFile} from '@/lib/fileSystemHelpers';
import {ChartFile} from '@/lib/preview/interfaces';
import {parseMidi} from '@/lib/preview/midi';
import {
  ChartParser,
  parseChart as scanParseChart,
} from '@/lib/preview/chart-parser';
import EncoreAutocomplete from '@/components/EncoreAutocomplete';
import chorusChartDb from '@/lib/chorusChartDb';
import {Searcher} from 'fast-fuzzy';
import {ChartResponseEncore} from '@/lib/chartSelection';
import {MidiParser} from '@/lib/preview/midi-parser';
import {ScannedChart, scanCharts} from 'scan-chart-web';

/*
Things I need from scan-chart
* Contents of TrackParser
* List of audio files / references to Audio Files
*/

export default function Preview() {
  const [chart, setChart] = useState<ChartParser | MidiParser | undefined>();
  const [audioFiles, setAudioFiles] = useState<File[]>([]);

  // const midFileFetch =
  //   'https://files.enchor.us/56d31d7c085f5e504b91e272e65d1cd3.sng';
  // const chartFileFetch =
  //   'https://files.enchor.us/c395e1d650182ccae787f37758f20223.sng';

  const handler = useCallback(async (chart: ChartResponseEncore) => {
    const downloadLocation = await getPreviewDownloadDirectory();
    // We should have a better way to manage this directory
    await emptyDirectory(downloadLocation);
    const downloadedSong = await downloadSong(
      'Artist',
      'Song',
      'charter',
      chart.file, // SWAP THIS OUT WITH midFileFetch TO TEST MIDI
      {
        folder: downloadLocation,
      },
    );

    if (downloadedSong == null) {
      return;
    }

    const songDir =
      await downloadedSong.newParentDirectoryHandle.getDirectoryHandle(
        downloadedSong.fileName,
      );

    // const chartInfo = await getChartInfo(
    //   downloadedSong.newParentDirectoryHandle,
    // );
    // console.log(chartInfo);

    const chartData = await getChartData(songDir);
    const songFiles = await getSongFiles(songDir);
    // const songUrls = songFile.map(file => URL.createObjectURL(file));
    // calculateTimes(chartData);

    // const audioFileHandle = await songDir.getFileHandle('song.opus');
    // const audioFile = await audioFileHandle.getFile();
    // const audioUrl = URL.createObjectURL(audioFile);

    setChart(chartData);
    setAudioFiles(songFiles);
  }, []);

  return (
    <div className="flex flex-col w-full flex-1">
      <TypeAhead onChartSelected={handler} />
      {chart && audioFiles.length > 0 && (
        <Highway chart={chart} audioFiles={audioFiles}></Highway>
      )}
    </div>
  );
}

async function getChartData(
  directoryHandle: FileSystemDirectoryHandle,
): Promise<ChartParser | MidiParser> {
  for await (const entry of directoryHandle.values()) {
    const name = entry.name.toLowerCase();
    if (entry.kind !== 'file') {
      continue;
    }

    let result: ChartParser | MidiParser | null = null;
    if (name == 'notes.chart') {
      const chart = await readTextFile(entry);

      const parsedChart = parseChart(chart);
      calculateTimes(parsedChart);

      const file = await entry.getFile();
      result = scanParseChart(await file.arrayBuffer());
      console.log(parsedChart, result);

      // return parsedChart;
      return result;
    } else if (name == 'notes.mid') {
      const file = await entry.getFile();
      result = parseMidi(await file.arrayBuffer());
      // console.log(result);
      // throw new Error('notes.mid files are not supported yet');
      return result;
    }
  }

  throw new Error('No .chart or .mid file found');
}

function TypeAhead({
  onChartSelected,
}: {
  onChartSelected: (chart: ChartResponseEncore) => void;
}) {
  const [searcher, setSearcher] = useState<Searcher<
    ChartResponseEncore,
    any
  > | null>(null);

  useEffect(() => {
    async function run() {
      const fetchChorusDb = await chorusChartDb();

      const artistSearcher = new Searcher(fetchChorusDb, {
        keySelector: chart => [chart.artist, chart.name],
        threshold: 1,
        useDamerau: false,
        useSellers: false,
      });

      setSearcher(artistSearcher);
    }
    run();
  }, []);

  return (
    <EncoreAutocomplete onChartSelected={onChartSelected} searcher={searcher} />
  );
}

async function getChartInfo(
  folder: FileSystemDirectoryHandle,
): Promise<ScannedChart> {
  return new Promise((resolve, reject) => {
    const emitter = scanCharts(folder);

    let foundChart: ScannedChart;
    emitter.on('chart', chart => {
      foundChart = chart;
    });

    emitter.on('end', async () => {
      resolve(foundChart);
    });
  });
}

// This should be reused from scan-chart
async function getSongFiles(folder: FileSystemDirectoryHandle) {
  const songFiles = [];
  for await (const entry of folder.values()) {
    if (entry.kind !== 'file') {
      continue;
    }
    const hasExtension = ['.ogg', '.mp3', '.wav', '.opus'].some(ext =>
      entry.name.endsWith(ext),
    );

    if (
      hasExtension &&
      !['preview', 'crowd'].some(base => entry.name.startsWith(base))
    ) {
      const file = await entry.getFile();
      songFiles.push(file);
    }
  }
  return songFiles;
}