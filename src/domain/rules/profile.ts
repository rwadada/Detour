/**
 * A named, saved rules.json snapshot (issue #19's Rules Profiles) — lets a
 * dashboard user switch which ruleset is active, or create a new one from a
 * template, without hand-editing files. Stored independently of whichever
 * file `RuleEngine` currently watches; "applying" a profile writes its rules
 * into that active file (see `RuleEngine.write()`), reusing the exact same
 * validate-and-hot-reload path a Rules editor save does.
 */
export interface RuleProfileSummary {
  /** The profile's filename (without `.json`) — also its unique id. */
  name: string;
  ruleCount: number;
  /** Epoch ms the profile file was last modified. */
  updatedAt: number;
}
