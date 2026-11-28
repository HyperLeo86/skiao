export const demoHeader = {"X-SkyAO-Demo": "test-console"};

export async function demoSession() {
  const reply = await fetch("/demo/session", {headers: demoHeader, cache: "no-store"});
  if (reply.status === 404) return null;
  if (!reply.ok) throw new Error("HTTP " + reply.status);
  return reply.json();
}
