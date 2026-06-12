import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

// WMO weather interpretation codes (subset) → human-readable conditions.
const WEATHER_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  51: "light drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  80: "rain showers",
  95: "thunderstorm",
};

interface GeocodeResponse {
  results?: {
    latitude: number;
    longitude: number;
    name: string;
    country?: string;
  }[];
}

interface ForecastResponse {
  current: {
    temperature_2m: number;
    wind_speed_10m: number;
    weather_code: number;
  };
}

/** Live weather via Open-Meteo — free, no API key required. */
export const weatherTool = createTool({
  id: "get-weather",
  description:
    "Get the current weather for a city. Call this whenever the user asks about weather conditions somewhere.",
  inputSchema: z.object({
    city: z.string().describe("City name, e.g. Tokyo or San Francisco"),
  }),
  outputSchema: z.object({
    city: z.string(),
    temperatureC: z.number(),
    windKmh: z.number(),
    conditions: z.string(),
  }),
  execute: async ({ city }) => {
    const geo = await fetch(
      `${GEOCODE_URL}?name=${encodeURIComponent(city)}&count=1`
    );
    if (!geo.ok) {
      throw new Error(`Geocoding failed: HTTP ${geo.status}`);
    }
    const place = ((await geo.json()) as GeocodeResponse).results?.[0];
    if (!place) {
      throw new Error(`Unknown city: ${city}`);
    }

    const forecast = await fetch(
      `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,wind_speed_10m,weather_code`
    );
    if (!forecast.ok) {
      throw new Error(`Weather lookup failed: HTTP ${forecast.status}`);
    }
    const { current } = (await forecast.json()) as ForecastResponse;

    return {
      city: place.country ? `${place.name}, ${place.country}` : place.name,
      temperatureC: current.temperature_2m,
      windKmh: current.wind_speed_10m,
      conditions:
        WEATHER_CODES[current.weather_code] ??
        `weather code ${current.weather_code}`,
    };
  },
});
