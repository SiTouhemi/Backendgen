import { describe, expect, it } from "vitest";
import { validateCronExpression } from "./feature.js";

describe("jobs cron validation", () => {
  it("accepts the runtime grammar and rejects invalid bounds or divisors", () => {
    expect(validateCronExpression("*/5 0 1 */2 *")).toBe(true);
    expect(validateCronExpression("*/0 * * * *")).toBe(false);
    expect(validateCronExpression("0 24 * * *")).toBe(false);
    expect(validateCronExpression("0 0 0 * *")).toBe(false);
    expect(validateCronExpression("0 0 * 13 *")).toBe(false);
    expect(validateCronExpression("0 0 * * 7")).toBe(false);
  });
});
