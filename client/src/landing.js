import { fetchStats } from "./app/config.js";

async function refresh() {
  const live = document.getElementById("live");
  const stats = document.getElementById("stats");
  try {
    const { online, rooms } = await fetchStats();
    live.textContent = online === 1 ? "1 person inside" : online > 1 ? `${online} people inside` : "Open now";
    stats.textContent = `${rooms.filter((r) => r.players > 0).length} active room(s)`;
  } catch {
    live.textContent = "Open now";
    stats.textContent = "";
  }
}
refresh();
setInterval(refresh, 10000);
