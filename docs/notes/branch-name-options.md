# Branch name options

Decided 2026-11-07 (Alex), from sketches in the real Settings page. The branch naming rows
exposed every mode's setting at once, under long labels ("Type and slug (feat/add-filter)")
and a five-line description.

## What changed

* **Labels** are Semantic, Prefix and Custom instructions. The saved values stay `semantic`,
  `prefix` and `custom`, so nothing migrates.
* **The dropdown explains its options.** Two new parallel schema lists, `EnumDescriptions`
  and `EnumExamples` (proto `enum_descriptions`, `enum_examples`), carry a sentence and a
  sample per option. The list shows name and example, then the sentence, 25rem wide and
  ending at the trigger's right edge. Other enums are unchanged.
* **The row** shows the picked option's sentence and example in place of the field's
  description. The example follows `projects.branch_prefix` (`enumExamples.ts`); custom has
  none, because the model writes that name.
* **`DependsOnValue`** (proto `depends_on_value`) ties a field to one value of an enum:
  Branch prefix to `prefix`, Branch instructions to `custom`. The section shows the field
  only then, under the parent with the existing elbow. Semantic has no setting of its own.
  A hidden field keeps its value, so switching back restores it.
* **Search** also reads explained options (name and sentence). "semantic" found nothing
  before, because options were never searched. Examples stay out: the one on screen follows
  the prefix, so a hit by the schema's sample could not be marked. A hit found by an option adds
  "Name: sentence" after the description, marked. Options without a sentence stay out of
  the search: "dark" should not list every field with a dark theme.
* **A hidden field is still found**, dimmed with "Not used while Branch names is Semantic."
  Its editor works, so a prefix can be set before switching mode. Hiding from the section
  and from the search are separate (`hiddenFieldKeys`' `from`).
* **The automatic naming caveat** is a description tail shown only while `threads.auto_name`
  is off (`BranchNamingOff`), worded for the mode in use.
* The guide's settings reference and the settings file's comments print each option's
  sentence and "Used when `projects.branch_naming` is `prefix`", since the descriptions no
  longer spell the modes out. The automatic naming caveat stays GUI only: the tail above.

## Gotchas

* The note under a dimmed row now sits outside the dimming, for bool dependents too: it is
  the one line that says why, and at 45% it was hard to read.
* "custom instruction" must find Branch instructions, so its description says "custom
  instructions" in words. Search does not read a parent's option labels for its dependents.
* A new GUI on an old daemon gets no descriptions and no `depends_on_value`: plain menu with
  the old labels, every row shown, which is today's page.
* Radix copies an item's text into the trigger, so everything but the name carries
  `[[data-slot=select-value]_&]:hidden`.
