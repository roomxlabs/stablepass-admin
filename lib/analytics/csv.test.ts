import { describe, it, expect } from "vitest";
import { toCsv, trialsCsvFilename } from "./csv";

describe("toCsv", () => {
  it("joins headers and rows with CRLF and a trailing newline", () => {
    const csv = toCsv(["a", "b"], [["1", "2"]]);
    expect(csv).toBe("a,b\r\n1,2\r\n");
  });

  it("quotes a cell containing a comma", () => {
    const csv = toCsv(["name"], [["Doe, John"]]);
    expect(csv).toBe('name\r\n"Doe, John"\r\n');
  });

  it("quotes and doubles an embedded double quote", () => {
    const csv = toCsv(["name"], [['Say "hi"']]);
    expect(csv).toBe('name\r\n"Say ""hi"""\r\n');
  });

  it("quotes a cell containing a newline", () => {
    const csv = toCsv(["note"], [["line1\nline2"]]);
    expect(csv).toBe('note\r\n"line1\nline2"\r\n');
  });

  it("quotes a cell containing a carriage return", () => {
    const csv = toCsv(["note"], [["line1\rline2"]]);
    expect(csv).toBe('note\r\n"line1\rline2"\r\n');
  });

  it("maps null/undefined cells to an empty string", () => {
    const csv = toCsv(["a", "b"], [[null, undefined]]);
    expect(csv).toBe("a,b\r\n,\r\n");
  });

  it("does not quote a plain numeric or text cell", () => {
    const csv = toCsv(["n"], [[42]]);
    expect(csv).toBe("n\r\n42\r\n");
  });

  it("prefixes a formula-injection cell starting with = (CSV injection guard)", () => {
    const csv = toCsv(["name"], [['=HYPERLINK("http://evil","x")']]);
    expect(csv).toBe('name\r\n"\'=HYPERLINK(""http://evil"",""x"")"\r\n');
  });

  it("prefixes a cell starting with +", () => {
    const csv = toCsv(["name"], [["+1234"]]);
    expect(csv).toBe("name\r\n'+1234\r\n");
  });

  it("prefixes a cell starting with -", () => {
    const csv = toCsv(["name"], [["-1234"]]);
    expect(csv).toBe("name\r\n'-1234\r\n");
  });

  it("prefixes a cell starting with @", () => {
    const csv = toCsv(["name"], [["@import"]]);
    expect(csv).toBe("name\r\n'@import\r\n");
  });

  it("prefixes AND quotes a cell that is both dangerous and contains a comma", () => {
    const csv = toCsv(["name"], [["=1,2"]]);
    expect(csv).toBe('name\r\n"\'=1,2"\r\n');
  });
});

describe("trialsCsvFilename", () => {
  it("formats as stablepass-trials-YYYY-MM-DD.csv in UTC", () => {
    const d = new Date(Date.UTC(2026, 6, 20, 23, 59));
    expect(trialsCsvFilename(d)).toBe("stablepass-trials-2026-07-20.csv");
  });
});
