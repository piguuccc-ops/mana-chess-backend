// Docker HEALTHCHECK for the backend: healthy when it answers on /api/info.
// (The image has no shell or curl – Node itself does the check.)
const port = process.env.PORT || 5454;
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(4000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
