import { describe, expect, it } from "vitest";
import csv from "../utils/csv.js";

const { parseCsvLine } = csv;

describe("parseCsvLine", () => {
  it("splits plain SoundVolumeView columns", () => {
    expect(parseCsvLine("Device Name,Default,Command-Line Friendly ID")).toEqual([
      "Device Name",
      "Default",
      "Command-Line Friendly ID",
    ]);
  });

  it("preserves quoted commas and escaped quotes", () => {
    expect(
      parseCsvLine('"VB-Audio, Virtual Cable",Render,"id ""quoted"""')
    ).toEqual(["VB-Audio, Virtual Cable", "Render", 'id "quoted"']);
  });

  it("trims unquoted field edges", () => {
    expect(parseCsvLine("  a  , b ,c ")).toEqual(["a", "b", "c"]);
  });
});
