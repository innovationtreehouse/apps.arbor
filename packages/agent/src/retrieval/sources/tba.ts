import type { Source } from "../plan.js";
import { NotConfigured, getJson } from "./http.js";

const TBA = "https://www.thebluealliance.com/api/v3";

// The Blue Alliance API v3: team profile plus that season's event statuses (rank, record).
export const tba: Source = async (plan) => {
  const key = process.env.TBA_AUTH_KEY;
  if (!key) throw new NotConfigured("TBA_AUTH_KEY not set");
  if (!plan.team) return { docs: [] };
  const headers = { "X-TBA-Auth-Key": key };
  const [team, statuses] = await Promise.all([
    getJson(`${TBA}/team/frc${plan.team}`, headers),
    getJson(`${TBA}/team/frc${plan.team}/events/${plan.year}/statuses`, headers),
  ]);
  return {
    docs: [{
      source: "tba",
      url: `https://www.thebluealliance.com/team/${plan.team}/${plan.year}`,
      title: `The Blue Alliance: team ${plan.team} in ${plan.year}`,
      text: JSON.stringify({ team, statuses }),
    }],
  };
};
