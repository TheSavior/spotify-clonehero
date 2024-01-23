'use client';

import {
  SongAccumulator,
  createIsInstalledFilter,
} from '@/lib/local-songs-folder/scanLocalCharts';
import {useCallback, useState} from 'react';
import chorusChartDb, {findMatchingCharts} from '@/lib/chorusChartDb';
import {scanForInstalledCharts} from '@/lib/local-songs-folder';
import {
  ArtistTrackPlays,
  getSpotifyDumpArtistTrackPlays,
  processSpotifyDump,
} from '@/lib/spotify-sdk/HistoryDumpParsing';
import SpotifyTableDownloader, {
  SpotifyChartData,
  SpotifyPlaysRecommendations,
} from '../SpotifyTableDownloader';
import {signIn, signOut, useSession} from 'next-auth/react';
import {Button} from '@/components/ui/button';
import {RxExternalLink} from 'react-icons/rx';
import SupportedBrowserWarning from '../SupportedBrowserWarning';
import {Searcher} from 'fast-fuzzy';
import {type ChartResponseEncore} from '@/lib/chartSelection';
import {toast} from 'sonner';

type Falsy = false | 0 | '' | null | undefined;
const _Boolean = <T extends any>(v: T): v is Exclude<typeof v, Falsy> =>
  Boolean(v);

/*
Todo: 
+ Add a time remaining progress bar
+ Fix sorting being weird 
+ Add link to "Other Tools" in navbar
+ Show chart names and artists for each chart
+ Add unsupported browser warning
+ Fix scanning performance
- Fix scrolling performance
- Show errors to the user?
+ Show preview button on song row
+ Download state isn't rendering
- Limit songs downloading in parallel. Gets "Too Many Requests" exception
+ Download songs to backup first, then copy over on success
+ Show all installed charts too
- Sort by artist/song if not selected. Don't show sort criteria (pushed to a branch, doesn't seem like a good idea)

Updates
  + Switch to exact match
*/

export default function Page() {
  let auth = null;
  const session = useSession();

  if (process.env.NODE_ENV === 'development') {
    auth =
      !session || session.status !== 'authenticated' ? (
        <div>
          <Button onClick={() => signIn('spotify')}>
            Sign in with Spotify
          </Button>
        </div>
      ) : (
        <div className="space-y-4 sm:space-y-0 sm:space-x-4 w-full text-start sm:text-start">
          <span>Logged in as {session.data.user?.name}</span>
          <Button onClick={() => signOut()}>Sign out</Button>
        </div>
      );
  }

  return (
    <>
      {auth}
      <p className="mb-4 text-center">
        This tool scans your Spotify{' '}
        <a
          href="https://www.spotify.com/us/account/privacy/"
          className="text-accent-foreground">
          Extended Streaming History <RxExternalLink className="inline" />
        </a>
        <br />
        and finds all the available charts on Encore for any song you&apos;ve
        ever listened to.
      </p>
      <SupportedBrowserWarning>
        <SpotifyHistory authenticated={session.status === 'authenticated'} />
      </SupportedBrowserWarning>
    </>
  );
}

type Status = {
  status:
    | 'not-started'
    | 'scanning'
    | 'done-scanning'
    | 'processing-spotify-dump'
    | 'songs-from-encore'
    | 'finding-matches'
    | 'done';
  songsCounted: number;
};

function SpotifyHistory({authenticated}: {authenticated: boolean}) {
  const [songs, setSongs] = useState<SpotifyPlaysRecommendations[] | null>(
    null,
  );
  const [status, setStatus] = useState<Status>({
    status: 'not-started',
    songsCounted: 0,
  });

  const handler = useCallback(async () => {
    let installedCharts: SongAccumulator[] | undefined;

    const fetchChorusDb = chorusChartDb();

    let artistTrackPlays = await getSpotifyDumpArtistTrackPlays();
    let spotifyDataHandle;
    if (artistTrackPlays == null) {
      alert(
        'Select the folder containing your extracted Spotify Extended Streaming History',
      );
      try {
        spotifyDataHandle = await window.showDirectoryPicker({
          id: 'spotify-dump',
        });
      } catch (err) {
        toast.info('Directory picker canceled');
        console.log('User canceled picker');
        return;
      }
    }

    console.log('scan local charts');
    try {
      setStatus({
        status: 'scanning',
        songsCounted: 0,
      });

      const scanResult = await scanForInstalledCharts(() => {
        setStatus(prevStatus => ({
          ...prevStatus,
          songsCounted: prevStatus.songsCounted + 1,
        }));
      });
      installedCharts = scanResult.installedCharts;
      setStatus(prevStatus => ({
        ...prevStatus,
        status: 'done-scanning',
      }));
      // Yield to React to let it update State
      await pause();
    } catch (err) {
      if (err instanceof Error && err.message == 'User canceled picker') {
        toast.info('Directory picker canceled');
        setStatus({
          status: 'not-started',
          songsCounted: 0,
        });
        return;
      } else {
        toast.error('Error scanning local charts');
        setStatus({
          status: 'not-started',
          songsCounted: 0,
        });
        throw err;
      }
    }

    console.log('get spotify listens');
    if (artistTrackPlays == null) {
      if (spotifyDataHandle == null) {
        throw new Error('Spotify data handle is null');
      }
      setStatus(prevStatus => ({
        ...prevStatus,
        status: 'processing-spotify-dump',
      }));
      // Yield to React to let it update State
      await pause();
      try {
        artistTrackPlays = await processSpotifyDump(spotifyDataHandle);
      } catch (err) {
        setStatus({
          status: 'not-started',
          songsCounted: 0,
        });

        if (err instanceof Error) {
          toast.error(err.message);
        }
        return;
      }
    }

    const flatTrackPlays = flattenArtistTrackPlays(artistTrackPlays);
    const isInstalled = await createIsInstalledFilter(installedCharts);
    const allChorusCharts = await fetchChorusDb;
    const markedCharts = markInstalledCharts(allChorusCharts, isInstalled);

    setStatus(prevStatus => ({
      ...prevStatus,
      status: 'songs-from-encore',
    }));

    // Yield to React to let it update State
    await pause();

    console.log('finding matches');
    setStatus(prevStatus => ({
      ...prevStatus,
      status: 'finding-matches',
    }));

    // Yield to React to let it update State
    await pause();

    const beforeSearcher = Date.now();

    const artistSearcher = new Searcher(markedCharts, {
      keySelector: chart => chart.artist,
      threshold: 1,
      useDamerau: false,
      useSellers: false,
    });
    console.log('Created index in', Date.now() - beforeSearcher, 'ms');

    const beforeMatching = Date.now();
    const recommendedCharts = flatTrackPlays
      .map(([artist, song, playCount]) => {
        const matchingCharts = findMatchingCharts(artist, song, artistSearcher);

        if (
          matchingCharts.length == 0 ||
          !matchingCharts.some(chart => !chart.isInstalled)
        ) {
          return null;
        }

        return {
          artist,
          song,
          playCount,
          matchingCharts,
        };
      })
      .filter(_Boolean);

    console.log('Found matches in', Date.now() - beforeMatching, 'ms');

    setStatus(prevStatus => ({
      ...prevStatus,
      status: 'done',
    }));

    if (recommendedCharts.length > 0) {
      setSongs(recommendedCharts);
      console.log(recommendedCharts);
    }
  }, []);

  return (
    <>
      <div className="flex justify-center">{renderStatus(status, handler)}</div>

      {songs && (
        <SpotifyTableDownloader tracks={songs} showPreview={authenticated} />
      )}
    </>
  );
}

function renderStatus(status: Status, scanHandler: () => void) {
  switch (status.status) {
    case 'not-started':
      return <Button onClick={scanHandler}>Scan Spotify Dump</Button>;
    case 'scanning':
    case 'done-scanning':
      return `${status.songsCounted} songs scanned`;
    case 'processing-spotify-dump':
      return 'Processing Spotify Extended Streaming History';
    case 'songs-from-encore':
      return 'Downloading songs from Encore';
    case 'finding-matches':
      return 'Checking for song matches';
    case 'done':
      return <Button onClick={scanHandler}>Rescan</Button>;
  }
}

function markInstalledCharts(
  allCharts: ChartResponseEncore[],
  isInstalled: (artist: string, song: string, charter: string) => boolean,
): SpotifyChartData[] {
  return allCharts.map(
    (chart): SpotifyChartData => ({
      ...chart,
      isInstalled: isInstalled(chart.artist, chart.name, chart.charter),
    }),
  );
}

async function pause() {
  // Yield to React to let it update State
  await new Promise(resolve => {
    setTimeout(resolve, 10);
  });
}

function flattenArtistTrackPlays(
  artistTrackPlays: ArtistTrackPlays,
): [artist: string, song: string, playCount: number][] {
  const results: [artist: string, song: string, playCount: number][] = [];
  for (const [artist, songs] of artistTrackPlays.entries()) {
    for (const [song, playCount] of songs.entries()) {
      results.push([artist, song, playCount]);
    }
  }

  return results;
}
