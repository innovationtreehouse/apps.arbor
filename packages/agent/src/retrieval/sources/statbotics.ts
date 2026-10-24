import type { Source } from "../plan.js";
import { getJson } from "./http.js";

// Statbotics open API: the team's EPA and record for the season.
export const statbotics: Source = async (plan) => {
  if (!plan.team) return { docs: [] };
  const data = await getJson<Record<string, unknown>>(`https://api.statbotics.io/v3/team_year/${plan.team}/${plan.year}`);
  if (Object.keys(data).length === 0) return { docs: [], note: `no data for team ${plan.team} in ${plan.year}` };
  return {
    docs: [{
      source: "statbotics",
      url: `https://www.statbotics.io/team/${plan.team}`,
      title: `Statbotics: team ${plan.team} in ${plan.year}`,
      text: JSON.stringify(data),
    }],
  };
};
