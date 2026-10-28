import { describe, expect, it } from "vitest";

import { clip, parseInline, parseMarkdown, safeHref } from "./markdown";

describe("parseInline", () => {
  it("parses bold, italic, code and safe links", () => {
    expect(parseInline("**231 mi** in *15h*, see `totals` and [Hawk Hill](/training/activities/123)")).toEqual([
      { type: "strong", children: [{ type: "text", text: "231 mi" }] },
      { type: "text", text: " in " },
      { type: "em", children: [{ type: "text", text: "15h" }] },
      { type: "text", text: ", see " },
      { type: "code", text: "totals" },
      { type: "text", text: " and " },
      { type: "link", href: "/training/activities/123", children: [{ type: "text", text: "Hawk Hill" }] },
    ]);
  });

  it("keeps raw HTML, external and script links as plain text", () => {
    expect(parseInline('<img src=x onerror="alert(1)">')).toEqual([
      { type: "text", text: '<img src=x onerror="alert(1)">' },
    ]);
    // The href stops at the first ")", so the leftover parenthesis stays as text.
    expect(parseInline("[click](javascript:alert(1))")).toEqual([{ type: "text", text: "click)" }]);
    expect(parseInline("[site](https://example.com)")).toEqual([{ type: "text", text: "site" }]);
    expect(safeHref("//evil.example/training")).toBeNull();
    expect(safeHref("/training/activities/1?tab=power")).toBe("/training/activities/1?tab=power");
  });

  it("leaves unclosed marks and snake_case alone while streaming", () => {
    expect(parseInline("**partial")).toEqual([{ type: "text", text: "**partial" }]);
    expect(parseInline("search_activities and gear_and_maintenance")).toEqual([
      { type: "text", text: "search_activities and gear_and_maintenance" },
    ]);
    expect(parseInline("2 * 3 = 6")).toEqual([{ type: "text", text: "2 * 3 = 6" }]);
  });
});

describe("parseMarkdown", () => {
  it("parses headings, paragraphs, lists and tables", () => {
    const blocks = parseMarkdown(
      [
        "### October",
        "You rode **231 mi**",
        "so far.",
        "",
        "- 2023: 329 mi",
        "- 2022: 366 mi",
        "",
        "1. First",
        "2. Second",
        "",
        "| Year | Miles |",
        "|------|------:|",
        "| 2026 | 231.6 |",
        "| 2023 | 328.8 |",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.type)).toEqual(["h", "p", "ul", "ol", "table"]);
    expect(blocks[1]).toEqual({
      type: "p",
      children: [
        { type: "text", text: "You rode " },
        { type: "strong", children: [{ type: "text", text: "231 mi" }] },
        { type: "text", text: " so far." },
      ],
    });
    const table = blocks[4] as Extract<(typeof blocks)[number], { type: "table" }>;
    expect(table.align).toEqual([null, "right"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1][1]).toEqual([{ type: "text", text: "328.8" }]);
  });

  it("handles a table header still streaming in", () => {
    expect(parseMarkdown("| Year | Miles |").map((block) => block.type)).toEqual(["p"]);
  });
});

describe("clip", () => {
  it("cuts long text with an ellipsis", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("a long answer here", 8)).toBe("a long…");
  });
});
