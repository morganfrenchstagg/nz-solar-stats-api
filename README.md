# OpenAPI Template

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/chanfana-openapi-template)

![OpenAPI Template Preview](https://imagedelivery.net/wSMYJvS3Xw-n339CbDyDIA/91076b39-1f5b-46f6-7f14-536a6f183000/public)

<!-- dash-content-start -->

This is a Cloudflare Worker with OpenAPI 3.1 Auto Generation and Validation using [chanfana](https://github.com/cloudflare/chanfana) and [Hono](https://github.com/honojs/hono).

This is an example project made to be used as a quick start into building OpenAPI compliant Workers that generates the
`openapi.json` schema automatically from code and validates the incoming request to the defined parameters or request body.

This template includes various endpoints, a D1 database, and integration tests using [Vitest](https://vitest.dev/) as examples. In endpoints, you will find [chanfana D1 AutoEndpoints](https://chanfana.com/endpoints/auto/d1) and a [normal endpoint](https://chanfana.com/endpoints/defining-endpoints) to serve as examples for your projects.

Besides being able to see the OpenAPI schema (openapi.json) in the browser, you can also extract the schema locally no hassle by running this command `npm run schema`.

<!-- dash-content-end -->

> [!IMPORTANT]
> When using C3 to create this project, select "no" when it asks if you want to deploy. You need to follow this project's [setup steps](https://github.com/cloudflare/templates/tree/main/openapi-template#setup-steps) before deploying.

## Distributed solar capacity job

A daily cron trigger (18:00 UTC) rebuilds how much solar is installed at each GXP, month by month since August 2013, from:

- EMI's [installed distributed generation trends](https://www.emi.ea.govt.nz/Retail/Reports/GUEHMT) report (solar, all market segments, per root NSP)
- the electricitymap [substations](https://api.electricitymap.frenchsta.gg/v1/substations) (GXPs) and [generators](https://api.electricitymap.frenchsta.gg/v1/generators) (dispatched solar farms)

EMI counts every ICP with solar, including large farms on distribution networks that the System Operator also dispatches, such as Kōwhai Park on Orion's network at Islington. Their output is already in public generation data, so the job finds the month(s) each dispatched farm appears in EMI (a step in installed capacity that new rooftop systems can't explain) and records it as `dispatched_mw`. `distributed_mw` (installed minus dispatched) is the solar that isn't counted anywhere else. A farm connected straight to the grid has no NSP of its own, but part of it can still turn up at NSPs within 20 km the month it's commissioned: Tauhei (150 MW at Waihou, May 2026) did as 17.8 MW at Piako and 4.3 MW at Waihou, which grid load at both barely showed as local generation. The matching rules are in `src/capacity/dispatchedSolar.ts`.

All capacities are the registry's nameplate capacity in MW AC: the lower of the panels' and the inverter's rating, not DC MWp. A farm's nameplate can be above its dispatch capacity; Kōwhai Park is 160 MW in the registry against 150 MW dispatched.

Tables:

- `solar_capacity`: per root NSP and month end; `gxp` is the substation site ID
- `dispatched_solar_steps`: the EMI steps attributed to each dispatched farm
- `gxps`: the substations list
- `capacity_job_runs`: one row per run; tables are only rewritten when the source data changed

Endpoints:

- `GET /solar-capacity?month=YYYY-MM`: every GXP at a month end (latest by default), with a national total
- `GET /solar-capacity/{gxp}`: one GXP's monthly history, plus the dispatched farm steps removed from it
- `GET /solar-production`: a live estimate of every GXP's distributed solar output now, with a 10-minute profile for today (NZ time)
- `GET /solar-production/{date}`: the same 10-minute profile for an NZ date (`YYYY-MM-DD`, `today` or `yesterday`), from about three months ago to two weeks ahead (as far as Open-Meteo has weather). Only today has live values.

EMI only publishes month-end snapshots, a few weeks after each month. So each GXP's capacity on a date is its latest snapshot on or before it, plus growth since at its recent rate (`src/production/capacity.ts`): an exponentially weighted average of the last year's month-on-month changes, each counting half as much as one three months newer. Farm-sized steps that aren't dispatched, such as Rānui's 10 MW at Blenheim, are stored as `step_mw` and left out of the rate, since they're one-offs. Predicting each month-end from the one before over 2024–26, this cut the NZ total's miss from 13.1 MW (always short) to 2.9 MW, and the average GXP's from 0.127 to 0.084 MW.

`/forecast` is a page charting that estimate for NZ or any one GXP, today or yesterday (e.g. `/forecast?gxp=ISL&day=yesterday`). It's a static file in `public/`, served by Workers Static Assets.

The production model (`src/production/estimate.ts`) splits each GXP's capacity in two:

- **Rooftops**, as arrays tilted 20° facing the ways PVOutput's NZ rooftop capacity does: 61% north, 9.5% each north-east and north-west, and 10% each east and west. Each has panels 1.15 times its registry capacity and 85% efficiency in full sun, falling in dim light by 0.08 × ln(1000 / irradiance) (13% lower at 200 W/m²).
- **Farms**: every farm-sized step in its capacity (`step_mw`, such as Rānui's 11 MW at Blenheim) as one fixed array facing north at 25°, with panels 1.3 times capacity, 88% efficiency and no dim-light loss. Blenheim has 24 MW of these steps, of 41 MW.

Both lose 0.4% of output per °C of cell heating. The light on each array is worked out from direct and diffuse sunlight with the Hay–Davies model (`src/production/solar.ts`), which comes within 1.5% of Open-Meteo's own tilted irradiance over a week, facing north, east, west or north-east.

The rooftop constants were fitted in October 2026 to 53 NZ rooftop systems on PVOutput, over 27 July – 25 October. PVOutput hides other people's locations, so each system was placed at the GXP whose satellite irradiance best tracked its day-to-day output; this agreed with every system named after a place. The first version of the model (all one north-facing array, 1.2 DC:AC, 83% efficiency, no dim-light loss) came out high: the systems' actual output was 0.91 of it overall, 0.88 on cloudy days and 0.92 on sunny ones. This version's ratio is 1.00 overall, 1.02 on cloudy days and 1.00 on sunny ones; the middle half of systems range from 0.89 to 1.08. East- and west-facing systems come in at 0.92 and north-facing ones at 1.02, since the mix is a fleet average. Rānui's own 15-minute output (22–25 October) fits the farm array much better than the rooftop mix: correlation 0.987 against 0.971, and 7.5% shape error against 11.2%. A tracker fits worse than either (r 0.86).

Dispatched solar farms modelled as the farm array come out at 0.67–1.04 of the model, depending on their layout. They come out about even across skies, at 1.06 on cloudy days and 1.00 on sunny ones (against each farm's own average), so farms don't share the rooftops' dim-light loss. At MHO0331, rooftop exports on cloudy days came to 0.40 of the model's generation, against 0.36 on sunny days, though self-consumption muddies that.

Weather is taken where each GXP's customers live, not at its substation, which can be well out of town (Mangahao's sits in the Tararua foothills, 13 km from Levin). `npm run gxp-locations` builds `src/production/gxpLocations.json` from [Kontur](https://www.kontur.io/portfolio/population-dataset/)'s 400 m population grid, assigning each hexagon to its nearest GXP (leaving out islands off the grid, like the Chathams): each GXP's population-weighted centre and its five most-populated satellite pixels. Rerun it when GXPs change; a GXP missing from it falls back to its substation.

Sunlight (global horizontal, direct normal and diffuse) comes from two [Open-Meteo](https://open-meteo.com/) sources (`src/production/blend.ts`), each component blended separately:

- For times that have already happened, Himawari-9 satellite readings: every 10 minutes on a ~5 km grid, about half an hour behind. GXPs of 5 MW or more average their five most-populated pixels, weighted by population; smaller ones use their most-populated pixel.
- After the latest reading, the forecast. How cloudy the last reading was compared with the forecast fades out over two hours, so the two don't jump apart.

The estimate runs every 10 minutes, the satellite's own interval, so its readings are used as they are. Finer would only be interpolation. Open-Meteo's forecast is hourly underneath (it only has true 15-minute data for Europe and North America, interpolating elsewhere), so after the latest reading the profile is smooth between hours.

The forecast, and temperature, are taken at the GXP's population centre. If the satellite fails, the estimate falls back to the forecast.

Weather is cached in D1 per date. The forecast is refreshed at most every three hours and the satellite at most hourly while the sun's up; a past day's of each is kept for good. Each cached day records where every GXP's weather was taken, so it's refetched once a GXP's points move: when `gxpLocations.json` is rebuilt, or a GXP grows past 5 MW and gets five pixels. A day Open-Meteo no longer has keeps its weather from the old points. Days cached in an older format (`CACHE_FORMAT` in `src/production/weather.ts`) are fetched again once, and can't be kept. Open-Meteo's free limit is 10,000 calls a day, with each GXP or satellite pixel counting as one: a day of steady use takes about 6,000, and each new past date about 470. Forecast responses with gaps are rejected with a 502 rather than cached. Weather data by Open-Meteo.com, licensed CC BY 4.0; satellite data from JMA/JAXA Himawari; population data from Kontur, licensed CC BY 4.0.

### Backtesting

`scripts/backtest.ts` compares the production model with metered solar exports for one POC, from EMI's monthly embedded generation files:

```bash
npm run backtest -- MHO0331 202608_Embedded_generation.csv 202609_Embedded_generation.csv --out mho0331.csv
npm run backtest -- farms 202608_Embedded_generation.csv 202609_Embedded_generation.csv
```

It runs the same model, weather blend, population-weighted locations and capacity growth as the API (or `--weather forecast` for the forecast alone, and `--capacity snapshot` for month-end snapshots without growth), takes capacity from the API (`--api`, default the local dev server), and picks out solar retailers as those exporting under 5% of their energy at night. It also breaks results down by sky: each day is classed as cloudy, partly cloudy or sunny by its clearness index (the share of top-of-atmosphere sunlight reaching the ground, below 0.4, 0.4–0.6, or 0.6 and above). Metered injection is what ICPs export after using their own solar, so it sits below modelled generation; the correlations and average-day shape are the fair test. Open-Meteo's forecast API, which the temperatures come from, only goes back about three months, so older months can't be backtested this way.

`farms` compares the dispatched solar farms in the files instead, each modelled at its own location and dispatch capacity on its own satellite pixel. Farms export everything they generate, so they check the model's level and the weather without self-consumption getting in the way. Timing is compared by each day's energy-weighted middle rather than its peak, which flat-topped farms make arbitrary.

`scripts/backtest-pvoutput.ts` does the same against [PVOutput](https://pvoutput.org/) systems' daily generation, which is gross output rather than exports, so its ratio is a direct check on the model:

```bash
npm run backtest:pvoutput -- ISL --radius 25
npm run backtest:pvoutput -- ISL --systems 12345 --from 2026-08-27 --to 2026-10-25
```

It needs `PVOUTPUT_API_KEY` and `PVOUTPUT_SYSTEM_ID` from your PVOutput Settings page, e.g. in `.env` (gitignored). Searching works with any key, but reading other people's systems needs Donation mode on your account; your own system doesn't. Free keys allow 60 requests an hour (300 with Donation mode), and each system takes about three. Each system is modelled at its own location with the capacity the registry would record: the lower of its panel and inverter ratings.

To run it locally:

```bash
npx wrangler d1 migrations apply DB --local
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+18+*+*+*"
```

## Getting Started

Outside of this repo, you can start a new project with this template using [C3](https://developers.cloudflare.com/pages/get-started/c3/) (the `create-cloudflare` CLI):

```bash
npm create cloudflare@latest -- --template=cloudflare/templates/openapi-template
```

A live public deployment of this template is available at [https://openapi-template.templates.workers.dev](https://openapi-template.templates.workers.dev)

## Setup Steps

1. Install the project dependencies with a package manager of your choice:
   ```bash
   npm install
   ```
2. Create a [D1 database](https://developers.cloudflare.com/d1/get-started/) with the name "openapi-template-db":
   ```bash
   npx wrangler d1 create openapi-template-db
   ```
   ...and update the `database_id` field in `wrangler.json` with the new database ID.
3. Run the following db migration to initialize the database (notice the `migrations` directory in this project):
   ```bash
   npx wrangler d1 migrations apply DB --remote
   ```
4. Deploy the project!
   ```bash
   npx wrangler deploy
   ```
5. Monitor your worker
   ```bash
   npx wrangler tail
   ```

## Testing

This template includes integration tests using [Vitest](https://vitest.dev/). To run the tests locally:

```bash
npm run test
```

Test files are located in the `tests/` directory, with examples demonstrating how to test your endpoints and database interactions.

## Project structure

1. Your main router is defined in `src/index.ts`.
2. Each endpoint has its own file in `src/endpoints/`.
3. Integration tests are located in the `tests/` directory.
4. For more information read the [chanfana documentation](https://chanfana.com/), [Hono documentation](https://hono.dev/docs), and [Vitest documentation](https://vitest.dev/guide/).
