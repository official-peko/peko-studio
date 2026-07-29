---
name: peko-product-style
description: Use when writing or reviewing anything a user will see in a Peko project - UI copy, landing pages, marketing text, dashboard strings, empty states, errors, buttons, README prose, or the visual design of a page or component. The standing bar is that nothing reads or looks machine-generated.
---

# Product style

The bar for anything shipped: it must not pattern-match to default LLM output.
The goal is not to avoid sounding polished. Most single items below are fine in
isolation. What gives generated work away is density and uniformity.

Apply this to user-visible text and UI. Code comments follow a separate, stricter
rule set in the `peko-development` skill.

## Writing

### Punctuation, the loudest tell

Count the em dashes before shipping. The right number is usually zero. Use a
period, a comma, a colon, or parentheses, or recast the sentence. Stacked
`clause - clause` asides in one paragraph are the signature rhythm to avoid; at
most one aside per paragraph, and two sentences is usually better.

Also drop: colons in headlines, semicolons in marketing copy, a trailing ellipsis
used to soften a claim, Title Case On Every Heading (use sentence case), and
parenthetical asides in every other sentence.

### Constructions to delete on sight

- "It's not just X, it's Y" and "not only... but also"
- "Whether you're X or Y..."
- "From X to Y," as an opener
- "That's where X comes in."
- "Think of it as..."
- "The result?" followed by a fragment
- "Here's the thing:" and "But here's what makes it different:"
- "No X. No Y. Just Z." and one-word sentence stacking like "Simple. Fast. Secure."
- "Say goodbye to X" and "Meet X." as a headline
- "In today's fast-paced world" and "In an era where"
- "Built by developers, for developers"
- An opening sentence that restates the heading directly above it
- A closing fragment that adds nothing, like "All in one place."

### Rule-of-three disease

Tricolons everywhere are a tell: three adjectives, three feature cards, three
bullets, three benefits. Vary list lengths. Use two, four, five. Use a sentence
instead of a list. If every list on the page has exactly three items, it reads
generated.

### Hedges and filler

Cut "designed to", "helps you", "allows you to", "enables you to", "makes it easy
to", "simply", "just", "effortlessly", "seamlessly", "smoothly", "with ease".

> "Peko is designed to help you seamlessly deploy your app" becomes "Peko deploys
> your app."

Say what it does, not what it is designed to do.

### Vocabulary to avoid

Nouns: realm, landscape, tapestry, testament, beacon, journey, ecosystem, synergy,
paradigm, myriad, plethora, cornerstone, backbone, powerhouse, game-changer.

Verbs: delve, leverage, harness, unlock, empower, elevate, streamline, supercharge,
revolutionize, transform, unleash, embark, foster, facilitate, utilize (say "use"),
navigate as a metaphor, showcase, boast, underscore, ensure, dive into.

Adjectives: seamless, robust, comprehensive, meticulous, intricate, nuanced,
pivotal, crucial, vital, cutting-edge, state-of-the-art, best-in-class,
world-class, bespoke, curated, vibrant, dynamic, innovative, versatile, holistic,
unparalleled, transformative.

Phrases: "at scale", "under the hood", "out of the box", "first-class", "batteries
included", "when it comes to", "in the world of", "a deep dive into", "it's worth
noting that", "plays a crucial role in", "stands as a testament to".

### Structural tells

Every section the same length and shape. An intro sentence restating the heading
before the real content. "In conclusion", "Overall", "Ultimately", "At the end of
the day". An unprompted FAQ. Explaining the obvious to pad length. Perfectly
parallel bullet grammar where every bullet starts with the same verb tense. Copy
with no numbers, names, limits, or versions in it anywhere.

### The specificity test

Concrete detail is the strongest fix, because generated copy is vague when it does
not know the product. Replace claims with facts.

> "Blazing fast builds" becomes "Builds run in about 40 seconds."
> "Robust security" becomes "Signed URLs, 15-minute expiry, no credentials on the runner."
> "Seamless deployment" becomes "One command: `peko deploy app`."

If a sentence would survive being pasted onto a competitor's site, it says nothing.

## Graphics and UI

### Emoji

Literal emoji as icons is banned in product UI. It is the visual equivalent of the
em dash. The clichéd mappings are the worst offenders: rocket for launch, lock for
security, lightning for speed, sparkles for AI, target for precision, gear for
settings, chart for analytics, package for builds, brain or robot for AI.

Use a real icon set as inline SVG, a text label, or nothing. Status belongs in a
word or a colored dot.

Decorative symbols used as ornament are the same problem. An arrow inside a link
is conventional and fine; a star before a heading is decoration. Checkmark bullets
in a feature list are a strong tell.

### Layout clichés

- The three-card feature row: icon, Title Case title, one-sentence blurb, times
  three, identical. The most recognizable generated landing-page unit.
- Perfect grids where nothing is weighted more than anything else
- Everything centered, with uniform vertical rhythm and identical section padding
- A hero of big centered headline, subhead, and two buttons, one solid and one
  ghost "Learn more"
- Alternating left/right image-text sections all the way down
- A stat row of round invented numbers: 10x faster, 99.9% uptime, 5-minute setup
- Testimonial cards with generic avatars and invented names
- A "trusted by" logo cloud with placeholder logos
- An unprompted pricing table with a middle tier marked "Most popular"

### Color and effect clichés

The purple-to-indigo gradient. Gradient text on a headline. Floating gradient
blobs in a hero background. Glassmorphism cards. Glow or heavy drop shadow on
everything. Dot-grid backgrounds. A dark hero with a radial spotlight. Neon accent
on near-black.

### Animation

Fade-in-up applied to every section. Staggered card reveals. Infinite float or
bob. Pulsing glow. Animated gradient shimmer. Typewriter headlines. Count-up
numbers on scroll. Infinite marquee logos. Hover scale on every card. A spinner
shown when nothing is loading.

Animation should communicate state or hierarchy. Decorative animation applied
uniformly should be cut.

### Dashboard and product UI

- No marketing voice inside a functional screen
- Do not over-explain or over-apologize in empty states and errors
- Help text must not restate the label above it
- Keep buttons short: "Generate assets", not "Click here to generate your store
  assets now"
- Replace vague status words with the concrete state. "Capturing screenshots" and
  "Signing" beat "Processing..." and "Working..."
- Use one term per concept across every screen
- Do not toast things that need no confirmation

## Before shipping

1. Does this sentence contain a fact only we could write? If not, cut or replace it.
2. Would I say this out loud to a user? If not, rewrite it.
3. Is this the third three-item list on the page?
4. Does this animation tell the user something?
5. Is this emoji doing a job an icon or a word would not do better?
6. Count the em dashes.

## Grep kit

```bash
# Em dashes in user-visible markup. Narrow the extensions to whatever the
# project actually uses: tsx/jsx for React, vue, svelte, astro, html.
grep -rn "—" src

# Emoji
grep -rlP "[\x{1F300}-\x{1FAFF}\x{2700}-\x{27BF}\x{2B00}-\x{2BFF}]" src

# Slop vocabulary
grep -rniE "seamless|effortless|robust|leverage|harness|unlock|empower|elevate|streamline|supercharge|cutting-edge|state-of-the-art|revolutioniz|game-chang|delve|realm|tapestry|testament|holistic|bespoke|curated|unparalleled" src

# Hedge verbs
grep -rniE "designed to|allows you to|enables you to|helps you|makes it easy to|simply |effortlessly|seamlessly" src

# Construction tells
grep -rniE "not just|not only|whether you|that's where|think of it as|say goodbye|in today's|under the hood|out of the box|at scale" src

# Decorative animation
grep -rniE "@keyframes (float|pulse|shimmer|glow|bob)|animation:.*(infinite)|fade-in-up|scale\(1\.0[0-9]\)" src
```
