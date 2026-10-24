import { Hono } from "hono";
import { fromHono } from "chanfana";
import { SolarCapacityList } from "./solarCapacityList";
import { SolarCapacityRead } from "./solarCapacityRead";

export const solarCapacityRouter = fromHono(new Hono());

solarCapacityRouter.get("/", SolarCapacityList);
solarCapacityRouter.get("/:gxp", SolarCapacityRead);
