import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Countries, Overview, Probes, Profile, ServerList, ServerListParams, ServerPage, Software, Timeseries, TopServers, Versions } from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type Params = Record<string, string | number | boolean | undefined>;

export async function apiGet<T>(path: string, params: Params = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const url = qs.size ? `${path}?${qs}` : path;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

const MINUTE = 60_000;

export function useOverview(scope: string) {
  return useQuery({ queryKey: ['overview', scope], queryFn: () => apiGet<Overview>('/api/overview', { scope }), refetchInterval: MINUTE, placeholderData: keepPreviousData });
}
export function useTimeseries(scope: string, hours: number) {
  return useQuery({
    queryKey: ['timeseries', scope, hours],
    queryFn: () => apiGet<Timeseries>('/api/timeseries', { scope, hours }),
    refetchInterval: MINUTE,
    placeholderData: keepPreviousData,
  });
}
export function useTopServers(scope: string, hours: number) {
  return useQuery({
    queryKey: ['top-servers', scope, hours],
    queryFn: () => apiGet<TopServers>('/api/top-servers', { scope, hours }),
    refetchInterval: MINUTE,
    placeholderData: keepPreviousData,
  });
}
export function useProfile(scope: string, days: number) {
  return useQuery({ queryKey: ['profile', scope, days], queryFn: () => apiGet<Profile>('/api/profile', { scope, days }), refetchInterval: 5 * MINUTE, placeholderData: keepPreviousData });
}
export function useVersions(scope: string) {
  return useQuery({ queryKey: ['versions', scope], queryFn: () => apiGet<Versions>('/api/versions', { scope }), refetchInterval: 5 * MINUTE, placeholderData: keepPreviousData });
}
export function useSoftware(scope: string) {
  return useQuery({ queryKey: ['software', scope], queryFn: () => apiGet<Software>('/api/software', { scope }), refetchInterval: 5 * MINUTE, placeholderData: keepPreviousData });
}
export function useProbes(scope: string) {
  return useQuery({ queryKey: ['probes', scope], queryFn: () => apiGet<Probes>('/api/probes', { scope }), refetchInterval: 5 * MINUTE, placeholderData: keepPreviousData });
}
export function useCountries() {
  return useQuery({ queryKey: ['countries'], queryFn: () => apiGet<Countries>('/api/countries'), refetchInterval: 5 * MINUTE, placeholderData: keepPreviousData });
}
export function useServers(params: ServerListParams) {
  return useQuery({ queryKey: ['servers', params], queryFn: () => apiGet<ServerList>('/api/servers', { ...params }), refetchInterval: MINUTE, placeholderData: keepPreviousData });
}
export function useServer(address: string, hours: number) {
  return useQuery({
    queryKey: ['server', address, hours],
    queryFn: () => apiGet<ServerPage>(`/api/server/${encodeURIComponent(address)}`, { hours }),
    refetchInterval: MINUTE,
    placeholderData: keepPreviousData,
    retry: (count, err) => !(err instanceof ApiError && (err.status === 404 || err.status === 400)) && count < 1,
  });
}
