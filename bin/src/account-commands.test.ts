import { describe, expect, test } from "bun:test";
import { parseAccountsAddArgs, parseAccountSetArgs } from "./account-commands";

describe("parseAccountsAddArgs", () => {
  test("parses name + --dir", () => {
    expect(parseAccountsAddArgs(["work", "--dir", "~/.claude-work"])).toEqual({ name: "work", dir: "~/.claude-work" });
  });
  test("supports --dir=", () => {
    expect(parseAccountsAddArgs(["work", "--dir=~/.claude-work"])).toEqual({ name: "work", dir: "~/.claude-work" });
  });
  test("returns null on --help", () => {
    expect(parseAccountsAddArgs(["--help"])).toBeNull();
  });
  test("returns null on -h", () => {
    expect(parseAccountsAddArgs(["-h"])).toBeNull();
  });
  test("throws when --dir is missing", () => {
    expect(() => parseAccountsAddArgs(["work"])).toThrow();
  });
  test("throws when name is missing", () => {
    expect(() => parseAccountsAddArgs(["--dir", "~/.claude-work"])).toThrow();
  });
});

describe("parseAccountSetArgs", () => {
  test("parses a name", () => {
    expect(parseAccountSetArgs(["work"])).toEqual({ account: "work" });
  });
  test("--clear means null", () => {
    expect(parseAccountSetArgs(["--clear"])).toEqual({ account: null });
  });
  test("returns null on --help", () => {
    expect(parseAccountSetArgs(["--help"])).toBeNull();
  });
  test("returns null on -h", () => {
    expect(parseAccountSetArgs(["-h"])).toBeNull();
  });
  test("throws on unknown option", () => {
    expect(() => parseAccountSetArgs(["--unknown"])).toThrow();
  });
  test("throws on extra positional", () => {
    expect(() => parseAccountSetArgs(["work", "extra"])).toThrow();
  });
});
