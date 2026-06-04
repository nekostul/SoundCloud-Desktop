import { searchLyrics, type LyricsSearchOptions, type LyricsResult } from '../lib/lyrics';

type BenchmarkCase = {
  id: string;
  trackUrn: string;
  artist: string;
  title: string;
  options: LyricsSearchOptions;
};

type FetchEvent = {
  endedAtMs: number;
  error: string | null;
  kind: string;
  method: string;
  ok: boolean;
  startedAtMs: number;
  status: number | null;
  url: string;
};

type ConsoleEvent = {
  level: 'log' | 'warn' | 'error';
  message: string;
  startedAtMs: number;
};

type CaseResult = {
  consoleEvents: ConsoleEvent[];
  durationMs: number;
  fetchEvents: FetchEvent[];
  id: string;
  result: {
    hasPlain: boolean;
    hasSynced: boolean;
    source: LyricsResult['source'] | null;
  };
};

type BenchmarkSummary = {
  averageMs: number;
  byCase: Array<{
    durationMs: number;
    fetchBreakdown: Record<string, number>;
    id: string;
    requestCount: number;
    resultSource: LyricsResult['source'] | null;
  }>;
  finishedAt: string;
  maxMs: number;
  minMs: number;
  totalMs: number;
};

type BenchmarkPayload = {
  cases: CaseResult[];
  summary: BenchmarkSummary;
};

const CASES: BenchmarkCase[] = [
  {
    id: 'easy-shape-of-you',
    trackUrn: 'benchmark:shape-of-you',
    artist: 'Ed Sheeran',
    title: 'Shape of You',
    options: {
      durationMs: 233000,
      forceRefresh: true,
      originalTitle: 'Shape of You',
      uploaderUsername: 'Ed Sheeran',
    },
  },
  {
    id: 'easy-viva-la-vida',
    trackUrn: 'benchmark:viva-la-vida',
    artist: 'Coldplay',
    title: 'Viva La Vida',
    options: {
      durationMs: 242000,
      forceRefresh: true,
      originalTitle: 'Viva La Vida',
      uploaderUsername: 'Coldplay',
    },
  },
  {
    id: 'easy-humble',
    trackUrn: 'benchmark:humble',
    artist: 'Kendrick Lamar',
    title: 'HUMBLE.',
    options: {
      durationMs: 177000,
      forceRefresh: true,
      originalTitle: 'HUMBLE.',
      uploaderUsername: 'Kendrick Lamar',
    },
  },
  {
    id: 'messy-weeknd',
    trackUrn: 'benchmark:messy-weeknd',
    artist: 'XORecords',
    title: 'The Weeknd - Blinding Lights (Official Audio)',
    options: {
      durationMs: 200000,
      forceRefresh: true,
      originalTitle: 'The Weeknd - Blinding Lights (Official Audio)',
      uploaderUsername: 'XORecords',
    },
  },
  {
    id: 'messy-carti',
    trackUrn: 'benchmark:messy-carti',
    artist: 'opium_archive',
    title: 'Playboi Carti - Magnolia.mp3 [Lyrics]',
    options: {
      durationMs: 181000,
      forceRefresh: true,
      originalTitle: 'Playboi Carti - Magnolia.mp3 [Lyrics]',
      uploaderUsername: 'opium_archive',
    },
  },
  {
    id: 'miss-case',
    trackUrn: 'benchmark:miss-case',
    artist: 'Totally Made Up Artist',
    title: 'This Song Does Not Exist 2026',
    options: {
      durationMs: 199000,
      forceRefresh: true,
      originalTitle: 'This Song Does Not Exist 2026',
      uploaderUsername: 'Totally Made Up Artist',
    },
  },
];

function classifyRequest(url: string): string {
  if (/genius\.com\/api\/search\/multi/i.test(url)) return 'genius-search';
  if (/genius\.com\//i.test(url)) return 'genius-page';
  if (/lrclib\.net\/api\/get/i.test(url)) return 'lrclib-get';
  if (/lrclib\.net\/api\/search/i.test(url)) return 'lrclib-search';
  return 'other';
}

function summarizeArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createScopedFetch(caseStartedAt: number, fetchEvents: FetchEvent[]): typeof window.fetch {
  const originalFetch = window.fetch.bind(window);
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = String(
      init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET'),
    );
    const event: FetchEvent = {
      endedAtMs: 0,
      error: null,
      kind: classifyRequest(url),
      method,
      ok: false,
      startedAtMs: performance.now() - caseStartedAt,
      status: null,
      url,
    };
    fetchEvents.push(event);

    try {
      const response = await originalFetch(input, init);
      event.ok = response.ok;
      event.status = response.status;
      event.endedAtMs = performance.now() - caseStartedAt;
      return response;
    } catch (error) {
      event.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      event.endedAtMs = performance.now() - caseStartedAt;
      throw error;
    }
  };
}

function createScopedConsole(
  caseStartedAt: number,
  consoleEvents: ConsoleEvent[],
): Pick<Console, 'log' | 'warn' | 'error'> {
  const original = {
    error: console.error.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };

  return {
    log: (...args: unknown[]) => {
      consoleEvents.push({
        level: 'log',
        message: args.map(summarizeArg).join(' '),
        startedAtMs: performance.now() - caseStartedAt,
      });
      original.log(...args);
    },
    warn: (...args: unknown[]) => {
      consoleEvents.push({
        level: 'warn',
        message: args.map(summarizeArg).join(' '),
        startedAtMs: performance.now() - caseStartedAt,
      });
      original.warn(...args);
    },
    error: (...args: unknown[]) => {
      consoleEvents.push({
        level: 'error',
        message: args.map(summarizeArg).join(' '),
        startedAtMs: performance.now() - caseStartedAt,
      });
      original.error(...args);
    },
  };
}

async function runCase(testCase: BenchmarkCase): Promise<CaseResult> {
  const fetchEvents: FetchEvent[] = [];
  const consoleEvents: ConsoleEvent[] = [];
  const caseStartedAt = performance.now();
  const scopedFetch = createScopedFetch(caseStartedAt, fetchEvents);
  const scopedConsole = createScopedConsole(caseStartedAt, consoleEvents);
  const originalFetch = window.fetch;
  const originalConsole = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  };

  window.fetch = scopedFetch;
  console.log = scopedConsole.log;
  console.warn = scopedConsole.warn;
  console.error = scopedConsole.error;

  try {
    const lyrics = await searchLyrics(
      testCase.trackUrn,
      testCase.artist,
      testCase.title,
      testCase.options,
    );
    const durationMs = performance.now() - caseStartedAt;
    return {
      consoleEvents,
      durationMs,
      fetchEvents,
      id: testCase.id,
      result: {
        hasPlain: Boolean(lyrics?.plain),
        hasSynced: Boolean(lyrics?.synced?.length),
        source: lyrics?.source ?? null,
      },
    };
  } finally {
    window.fetch = originalFetch;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
}

function buildSummary(cases: CaseResult[]): BenchmarkSummary {
  const totalMs = cases.reduce((sum, item) => sum + item.durationMs, 0);
  const durations = cases.map((item) => item.durationMs);

  return {
    averageMs: totalMs / Math.max(cases.length, 1),
    byCase: cases.map((item) => ({
      durationMs: item.durationMs,
      fetchBreakdown: item.fetchEvents.reduce<Record<string, number>>((acc, event) => {
        const durationMs = Math.max(event.endedAtMs - event.startedAtMs, 0);
        acc[event.kind] = (acc[event.kind] ?? 0) + durationMs;
        return acc;
      }, {}),
      id: item.id,
      requestCount: item.fetchEvents.length,
      resultSource: item.result.source,
    })),
    finishedAt: new Date().toISOString(),
    maxMs: durations.length ? Math.max(...durations) : 0,
    minMs: durations.length ? Math.min(...durations) : 0,
    totalMs,
  };
}

async function runBenchmark(): Promise<BenchmarkPayload> {
  const cases: CaseResult[] = [];
  for (const testCase of CASES) {
    cases.push(await runCase(testCase));
  }
  return {
    cases,
    summary: buildSummary(cases),
  };
}

async function main() {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (root) {
    root.textContent = 'Running lyrics benchmark...';
    root.dataset.benchmarkDone = 'false';
    root.dataset.benchmarkError = '';
  }

  try {
    const payload = await runBenchmark();
    (
      window as typeof window & {
        __lyricsBenchmarkDone?: boolean;
        __lyricsBenchmarkResult?: BenchmarkPayload;
      }
    ).__lyricsBenchmarkResult = payload;
    (
      window as typeof window & {
        __lyricsBenchmarkDone?: boolean;
      }
    ).__lyricsBenchmarkDone = true;

    if (root) {
      root.dataset.benchmarkDone = 'true';
      root.dataset.benchmarkError = '';
      root.dataset.benchmarkSummary = JSON.stringify(payload.summary);
      root.textContent = JSON.stringify(payload.summary, null, 2);
    }
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    (
      window as typeof window & {
        __lyricsBenchmarkDone?: boolean;
        __lyricsBenchmarkError?: string;
      }
    ).__lyricsBenchmarkError = message;
    (
      window as typeof window & {
        __lyricsBenchmarkDone?: boolean;
      }
    ).__lyricsBenchmarkDone = true;

    if (root) {
      root.dataset.benchmarkDone = 'true';
      root.dataset.benchmarkError = message;
      root.textContent = message;
    }
    throw error;
  }
}

void main();
