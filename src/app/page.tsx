'use client';

import { useEffect, useState } from 'react';

interface SiteStatus {
  name: string;
  url: string;
  status: 'up' | 'down';
  responseTime: number;
  httpCode: number;
  lastChecked: string;
  uptime24h: number | null;
  uptime7d: number | null;
  trend: 'stable' | 'improving' | 'degrading';
  error?: string | null;
  warnings?: string[];
  webflow?: {
    lastPublished: string | null;
    displayName: string;
  } | null;
}

interface StatusData {
  checkTime: string;
  displayTime: string;
  allHealthy: boolean;
  results: SiteStatus[];
}

// The monitor (GitHub Actions) writes this file every 5 minutes.
const STATUS_URL = 'https://raw.githubusercontent.com/galangster/pye-dashboard/data/status.json';
// GitHub can start scheduled runs late, so allow 45 minutes before calling the data stale.
// healthchecks.io is the real alarm for a stopped monitor; this banner is for people viewing the page.
const STALE_AFTER_MS = 45 * 60 * 1000;

export default function Dashboard() {
  const [data, setData] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const res = await fetch(STATUS_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to fetch');
      setData(await res.json());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 60000);
    return () => clearInterval(interval);
  }, []);

  const sites = data?.results || [];
  const allUp = data?.allHealthy ?? false;
  const stale = data ? Date.now() - Date.parse(data.checkTime) > STALE_AFTER_MS : false;

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Detroit'
    }) + ' ET';
  };

  const getTrendIcon = (trend: string) => {
    switch (trend) {
      case 'improving': return '↗️';
      case 'degrading': return '↘️';
      default: return '➡️';
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-900">
      <div className="max-w-6xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-zinc-900 dark:text-white mb-2">
            🛡️ Protect Young Eyes
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Website Monitoring Dashboard
          </p>
        </div>

        {(stale || loadError) && (
          <div role="alert" className="rounded-2xl p-4 mb-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200">
            {loadError
              ? 'Could not load the latest status. The figures below may be out of date.'
              : `The monitor has not reported since ${data?.displayTime}. Treat this page as out of date until it resumes.`}
          </div>
        )}

        {/* Status Overview */}
        <div className={`rounded-2xl p-6 mb-8 ${allUp ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className={`w-4 h-4 rounded-full ${allUp ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
              <div>
                <h2 className={`text-xl font-semibold ${allUp ? 'text-green-800 dark:text-green-200' : 'text-red-800 dark:text-red-200'}`}>
                  {allUp ? 'All Systems Operational' : 'Issues Detected'}
                </h2>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  Last checked: {data?.displayTime || '—'}
                </p>
              </div>
            </div>
            <button
              onClick={fetchStatus}
              disabled={loading}
              className="px-4 py-2 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-lg font-medium hover:bg-zinc-700 dark:hover:bg-zinc-200 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Sites Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          {sites.map((site) => (
            <div
              key={site.name}
              className="bg-white dark:bg-zinc-800 rounded-xl p-6 shadow-sm border border-zinc-200 dark:border-zinc-700"
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-zinc-900 dark:text-white">
                    {site.name}
                  </h3>
                  <a
                    href={site.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-700"
                  >
                    {site.url}
                  </a>
                </div>
                <span className={`shrink-0 px-3 py-1 rounded-full text-sm font-medium ${
                  site.status === 'up' 
                    ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' 
                    : 'bg-red-100 text-red-800'
                }`}>
                  {site.status.toUpperCase()}
                </span>
              </div>
              
              {site.error && (
                <p className="text-sm text-red-700 dark:text-red-300 mb-4">{site.error}</p>
              )}
              {site.warnings?.map((w) => (
                <p key={w} className="text-sm text-amber-700 dark:text-amber-300 mb-2">⚠️ {w}</p>
              ))}

              {/* Stats Grid */}
              <div className="grid grid-cols-3 gap-4 text-sm mb-4">
                <div>
                  <p className="text-zinc-500 dark:text-zinc-400">Response</p>
                  <p className="font-medium text-zinc-900 dark:text-white">{site.responseTime}ms</p>
                </div>
                <div>
                  <p className="text-zinc-500 dark:text-zinc-400">24h Uptime</p>
                  <p className={`font-medium ${site.uptime24h !== null && site.uptime24h < 99 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>{site.uptime24h ?? '—'}{site.uptime24h !== null && '%'}</p>
                </div>
                <div>
                  <p className="text-zinc-500 dark:text-zinc-400">7d Uptime</p>
                  <p className="font-medium text-zinc-900 dark:text-white">{site.uptime7d ?? '—'}{site.uptime7d !== null && '%'}</p>
                </div>
              </div>

              {/* Trend & Webflow */}
              <div className="flex items-center justify-between text-sm border-t border-zinc-100 dark:border-zinc-700 pt-4">
                <div className="flex items-center gap-2">
                  <span>{getTrendIcon(site.trend)}</span>
                  <span className="text-zinc-600 dark:text-zinc-400 capitalize">{site.trend}</span>
                </div>
                {site.webflow?.lastPublished && (
                  <div className="text-zinc-500 dark:text-zinc-400">
                    Published: <span className="text-zinc-700 dark:text-zinc-300">{formatDate(site.webflow.lastPublished)}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="text-center text-sm text-zinc-500 dark:text-zinc-400">
          <p>Checks every 5 minutes • Email alerts on downtime, SSL and domain expiry</p>
        </div>
      </div>
    </div>
  );
}
