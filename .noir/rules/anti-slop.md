# Anti-slop rules

Plain, specific prose beats decorated prose. These rules catch the wording a
reader has to untangle before they can act on it.

## Banned words

Prefer plain verbs and concrete nouns. Do not use: delve, utilize, leverage,
facilitate, elucidate, embark, endeavor, encompass, multifaceted, tapestry,
testament, paradigm, synergy, holistic, catalyze, juxtapose, realm, landscape,
myriad, plethora.

## Rationed words

Use at most one of these per paragraph: robust, comprehensive, seamless,
cutting-edge, innovative, streamline, empower, foster, enhance, elevate, optimize,
scalable, pivotal, intricate, profound, resonate, underscore, navigate, cultivate,
bolster, galvanize, cornerstone, game-changer.

## Filler and frame phrases

Delete filler phrases (it is important to note that, needless to say) and slop
trigrams (a testament to, in the realm of, serves as a). Write the claim, not the
frame around it.

## Em-dashes and contrasts

Keep em-dashes to at most two per paragraph. Avoid the not-X-but-Y contrast: it
adds a fake turn without adding information.

## The laziness ladder

Climb these rungs in order and stop at the first one that holds.

- **Does this need to exist?** A speculative need is a reason to skip it, not
  build it.
- **Is it already here?** Reuse what the codebase has before writing anything
  new.
- **Does the standard library do it?** Prefer it over a new dependency.
- **Does the platform do it?** A native feature beats a library that wraps it.
- **Can it be one line?** One line beats fifty.
- **Can it be deleted?** Removing code is a smaller change than adding code.
- **Fix the root cause, not the symptom.** Guard the shared path every caller
  routes through, not the one caller a report names.

## The noir-debt: marker

When you deliberately cut a corner with a known limit, leave a `noir-debt:`
marker in the code that names the ceiling and the upgrade trigger: the condition
that means the shortcut has stopped holding and the real fix is due.
