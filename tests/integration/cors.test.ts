import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const origin = { Origin: "https://example.com" };

describe("CORS", () => {
	it("lets any site read the API", async () => {
		const response = await SELF.fetch("http://local.test/openapi.json", { headers: origin });

		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("includes the header on errors", async () => {
		const response = await SELF.fetch("http://local.test/solar-capacity/XYZ", { headers: origin });

		expect(response.status).toBe(404);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("answers preflights for reads only", async () => {
		const response = await SELF.fetch("http://local.test/solar-production", {
			method: "OPTIONS",
			headers: { ...origin, "Access-Control-Request-Method": "GET" },
		});

		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET,HEAD,OPTIONS");
	});
});
