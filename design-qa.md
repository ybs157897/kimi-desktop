# Desktop streaming timeline and interaction dock — design QA

## Evidence

- Source visual truth: `/var/folders/gl/fpk3jftx5y50txjpk1k7zr280000gn/T/codex-clipboard-9b01500b-d96c-42aa-a8a1-008b83f2cde9.png` (903 × 651 px), supported by the user's related Codex screenshots for question and plan-review states.
- Current source visual truth: `/var/folders/gl/fpk3jftx5y50txjpk1k7zr280000gn/T/codex-clipboard-7b872c7c-aca1-4ca8-877a-62cd3d172733.png` and `/var/folders/gl/fpk3jftx5y50txjpk1k7zr280000gn/T/codex-clipboard-148cb86a-4b66-46e5-99bc-107c60a96524.png`; together they specify the Kimi result layout and the single Codex-style process disclosure.
- Status-footer removal source: `/var/folders/gl/fpk3jftx5y50txjpk1k7zr280000gn/T/codex-clipboard-e94d814e-51e0-4d4c-bb53-2ba68aaf274a.png` (1122 × 37 px), paired with the explicit instruction to remove that entire strip.
- Rendered implementation: `/var/folders/gl/fpk3jftx5y50txjpk1k7zr280000gn/T/orca-computer-use/000bedd7-bc29-4bda-8653-d41b354540fe-screenshot.png` (1889 × 958 px).
- Current rendered implementation: `.tmp/design-qa/kimi-desktop-collapsed-process.jpg` (972 × 768 px), with a 757 px-wide native app surface beside docked DevTools.
- Status-footer removal implementation: `.tmp/design-qa/kimi-desktop-no-statusbar.jpg` (972 × 768 px), captured from the native Electron window after hot reload.
- Live-stream implementation: `/var/folders/gl/fpk3jftx5y50txjpk1k7zr280000gn/T/orca-computer-use/c2b47f80-6629-4d73-9561-bd7f77b1c6a2-screenshot.png` (1889 × 958 px).
- Combined comparison: `.tmp/timeline-design-qa-combined.png` (1806 × 651 px).
- Current combined comparison: `.tmp/design-qa/collapsed-process-comparison.png` (1151 × 808 px), using focused conversation crops from the current Codex reference and native implementation.
- Status-footer comparison: `.tmp/design-qa/statusbar-removal-comparison.png` (1122 × 244 px), showing the referenced footer above the new edge-to-edge app bottom.
- Viewport: 1889 × 958 CSS px, device scale 1, macOS light theme.
- Density normalization: source and implementation are both 1×. The implementation comparison uses a 903 × 651 native-resolution crop of the conversation/composer region.
- State: one settled rejected plan turn and one running turn with two Read calls; sidebar expanded and right panel collapsed.

## Findings

No actionable P0, P1, or P2 differences remain for the requested timeline behavior.

- Each turn now has one compact `已处理 {时长}` disclosure. Thinking, commands, tool output, notices, task messages, and process commentary are all folded behind it by default.
- The final non-empty assistant message remains directly visible after a settled turn. During a live turn, assistant text is visible only while it is the streaming tail; once a tool starts, that commentary moves back into the folded process.
- Empty streaming text frames render nothing, eliminating the isolated blinking cursor row. A live turn with no reasoning delta keeps only a small thinking affordance rather than reserving a blank body.
- Expanding the turn disclosure reveals the existing compact reasoning and tool rows without losing their own detail controls.
- Internal `undo`, `plan.*`, `interruption`, swarm-start, and other technical markers are excluded from the visible conversation. Only the meaningful compaction marker remains.
- Pending questions and approvals stay outside the collapsed process, so required user actions cannot be hidden.
- The 28 px model/thinking/git/context status footer is no longer mounted. Sidebar navigation, composer, conversation, and right dock now consume the full window height without a replacement strip.
- Rejecting an approval aborts the active prompt after the rejection is recorded. Explicit plan `Revise` remains the only rejected decision that intentionally continues.

## Required fidelity surfaces

- Fonts and typography: the system UI stack, chat type sizes, optical weights, line heights, and truncation match the surrounding Codex-style Desktop. Monospace is limited to tool identity/input details.
- Spacing and layout rhythm: one 11.5 px disclosure label and a flexible divider establish a quiet boundary between the user prompt and result. The 757 px-wide native capture shows no clipping or horizontal overflow.
- Colors and visual tokens: neutral surfaces, quiet borders, secondary text, and semantic green/orange/red states all reuse existing Desktop tokens.
- Image quality and assets: this surface has no raster product imagery. Icons continue to use the existing Phosphor family; no custom drawings or placeholder assets were introduced.
- Copy and content: the default surface is reduced to `处理中` or `已处理 {时长}` plus the final result. Expanded content retains user-facing tool labels and states; engine markers remain hidden.
- Accessibility and interaction states: disclosures remain buttons, the pending card retains keyboard-accessible answer/approve/reject actions, and its bounded dock prevents it from covering the composer or overflowing the viewport.

## Comparison history

### Iteration 1

- P2: every completed reasoning frame displayed the full turn duration (5 分 26 秒), making repeated labels inaccurate and visually noisy.
- Fix: passed the enclosing step duration to each reasoning frame and formatted that value in the collapsed label.
- Post-fix evidence: the live accessibility capture reports per-step durations such as `持续了 3 秒`, `持续了 5 秒`, and `持续了 6 秒`.

### Iteration 2

- P2: an older plan session still exposed `plan.enter` and `interruption` as raw timeline copy.
- Fix: changed the presentation allowlist so only `compact` and `swarm.enter` markers are user-visible.
- Post-fix evidence: a refreshed native Desktop accessibility capture contains none of `已撤销到这里`, `plan.enter`, `plan.revision`, or `interruption`.

### Iteration 3

- P2: individual reasoning and tool disclosures still occupied the default reading flow, while the new reference calls for one turn-level process disclosure and only the final result beneath it.
- Fix: added turn-level result selection and folded every non-result frame behind a single `处理中` / `已处理 {时长}` control. Pending interactions and terminal errors remain directly visible.
- Post-fix evidence: the native accessibility capture exposes `已处理 4 秒` and `已处理 11 秒` followed immediately by the corresponding assistant results. Expanding `已处理 11 秒` reveals both reasoning frames and the two Read calls; collapsing it removes those five process rows again.

### Iteration 4

- P2: the bottom status footer still occupied a full-width strip with thinking level, git branch, and context usage after the conversation process was simplified.
- Fix: removed the `StatusBar` mount from the application shell while preserving the existing component file and unrelated panel state.
- Post-fix evidence: the native accessibility tree no longer contains the footer's thinking, branch, context, terminal, or workspace controls. The 972 × 768 capture shows the composer, sidebar navigation, and right dock reaching the bottom window edge.

Focused-region comparison was required because the process label and hidden tool rows were too small to judge from the whole window. The current 1151 × 808 combined image keeps the Codex reference and Kimi conversation crop readable. Result selection across settled and live turns is additionally covered by a deterministic test.

## Verification

- Desktop tests: 153/153 passed.
- Desktop TypeScript checks: passed.
- Desktop production build: passed.
- Native Electron settled state: passed at a 757 px-wide app surface; only the single process disclosure and final result are visible by default.
- Native Electron disclosure interaction: passed; expand and collapse both update the accessibility tree and preserve the result.
- Native Electron status-footer removal: passed; no bottom footer appears in the screenshot or accessibility tree, and the remaining regions fill the reclaimed height.
- Native Electron live-stream state: covered by the result-selection test; live assistant text is exposed only at the streaming tail, while a later thinking or tool frame returns it to the folded process.
- Native Electron settled rejected-plan state: passed; compact reasoning/tools, rejection is terminal, internal marker pills absent.
- Runtime/console errors in the current rendered state: no render errors attributable to this change. Docked DevTools retained stale WebSocket warnings from an older backend connection, which did not affect the loaded transcript or disclosure interaction.

final result: passed

---

# Desktop AI 三省六部窄窗口与子 Agent — design QA

## Evidence

- Source visual truth: `/Users/yin/Documents/ybs/code/proxy/kimiwork/kimi-code/docs/agent-trace-office-liubu.html`.
- Implementation preview: `http://127.0.0.1:4182/`.
- Combined comparison: `/Users/yin/Documents/ybs/code/proxy/kimiwork/kimi-code/.tmp/design-qa/liubu-narrow-comparison.png`.
- Viewport: both source and implementation rendered in 720 × 768 CSS px iframes at the same 0.75 display scale.
- State: six primary officials plus one overflow subagent, live swarm mode, milestone panel, unselected roster detail.

## Findings

No actionable P0, P1, or P2 differences remain for this correction.

- All seven official illustrations are visible, sharp, correctly positioned, and retain distinct robe colors.
- The 720 px layout no longer inherits a 620 px minimum content width. Header, stage, and lower panels stay within the viewport without horizontal page overflow.
- Narrow mode reduces header, chip, label, border, shadow, and panel density while preserving the visual hierarchy and live status information.
- Desk labels omit the secondary task line at this width; full task information remains available in the roster detail panel.
- The child-agent prompt stays readable but no longer mounts the visually redundant up/down toggle.
- Opening a child agent from the office now returns to the conversation layout before revealing its right-side chat, avoiding an invisible dock behind the office view.

## Required fidelity surfaces

- Typography and spacing: the current implementation remains slightly denser than the static reference because it displays real agent identifiers, but all rows have distinct breathing room and no labels overlap officials.
- Colors and image assets: the production standalone SVG officials and room asset match the existing paper, ink, vermilion, gold, blue, green, and purple palette.
- Responsive behavior: the 720 px comparison keeps the full six-desk stage visible; the roster scrolls horizontally; the two detail panels remain aligned below it.
- Accessibility and interaction: officials and roster chips remain keyboard buttons with selection state; the removed child-prompt toggle had no replacement because the prompt is always visible.

## Comparison history

### Iteration 1

- P1: the browser preview rendered standalone officials, but the packaged Electron `file:` page did not reliably display the same small SVGs after Vite inlined them as `data:` URLs.
- Fix: added Vite's targeted `?no-inline` asset query to all six official imports, so the production package carries normal sibling SVG files instead of data URLs.
- Post-fix evidence: the rebuilt `app.asar` contains all six hashed `out/renderer/assets/official-*.svg` entries, and the browser preview continues to render the same source assets without layout changes.

### Iteration 2

- P2: the narrow breakpoint retained a fixed 620 px main minimum width and full-size labels, producing unnecessary density inside the Desktop content column.
- Fix: removed the minimum width, introduced a 760 px compact mode, hid duplicate task copy on the stage, and reduced borders, shadows, labels, chips, and panel padding.
- Post-fix evidence: the same-state 720 × 768 combined comparison shows every official and all major panels without horizontal page overflow.

## Verification

- Desktop TypeScript checks: passed.
- Desktop tests: 160/160 passed.
- Desktop production build: passed.
- Same-input source/implementation visual comparison: passed at 720 × 768.

final result: passed

---

# Desktop AI 三省六部办公室 — design QA

## Evidence

- Source visual truth: `/Users/yin/Documents/ybs/code/proxy/kimiwork/kimi-code/docs/agent-trace-office-liubu.html`, captured as `/Users/yin/Documents/ybs/code/proxy/kimiwork/kimi-code/.tmp/design-qa/liubu-reference-1280x820.png`.
- Implementation screenshot: `/Users/yin/Documents/ybs/code/proxy/kimiwork/kimi-code/.tmp/design-qa/liubu-implementation-1280x820.png`.
- Focused interaction screenshot: `/Users/yin/Documents/ybs/code/proxy/kimiwork/kimi-code/.tmp/design-qa/liubu-selected-agent-1280x820.png`.
- Viewport: 1280 × 820 CSS px for both source and implementation; device scale factor 1.
- Pixel dimensions and normalization: both full-view captures are 1280 × 820 px at 1×. No resampling or density conversion was required.
- State: source live replay with six officials; implementation live swarm projection with main agent, nested expert team, two swarm members, a background agent, and one overflow subagent.
- Full-view comparison evidence: source and implementation were emitted together in one comparison input at the same viewport. Both preserve the paper field, ink borders and offset shadows, two-row header hierarchy, six-desk illustrated office, status vocabulary, milestone panel, and official roster panel.
- Focused-region evidence: the selected expert capture verifies the active chip/official treatment, expert badge, parent-agent attribution, activity ledger, stats, model metadata, and visible “查看此官对话” action. A separate crop was unnecessary because the 1280 × 820 selected-state capture keeps the complete detail panel readable.

## Findings

No actionable P0, P1, or P2 differences remain.

- The implementation intentionally replaces the reference's demo-volume tabs with live collaboration-mode and session-objective data. This is required by the product protocol and preserves the reference's bordered seal treatment and header hierarchy.
- The source illustration and official art direction are preserved as production SVG resources. The implementation extends the six-desk source with a compact overflow area and horizontal roster so more than six live agents remain reachable.
- Dynamic labels are denser than the replay sample because they show real agent identifiers, roles, modes, and tasks; truncation and the detail panel keep this usable without changing the overall comic-office composition.

## Required fidelity surfaces

- Fonts and typography: the implementation uses the local Chinese system stack for reliable offline Electron rendering, with heavy display weights, compact small-copy line heights, and monospace only for runtime-like metadata. The optical hierarchy matches the source despite not depending on its remote display font.
- Spacing and layout rhythm: the 1280 × 820 comparison confirms matching major-region proportions, 4 px ink frames, offset shadows, header/stage/sidebar rhythm, and readable desk spacing. No persistent control is clipped in the default state.
- Colors and visual tokens: paper, panel, ink, vermilion, gold, blue, green, purple, pink, and orange values follow the source palette; lifecycle status colors remain semantically consistent.
- Image quality and asset fidelity: the room and six robe-color official illustrations are production SVG assets derived from the supplied visual source. They render sharply at 1× with no transparency halos or raster scaling artifacts.
- Copy and content: the source's 官署 vocabulary is retained while static replay copy is replaced with live concepts: 独任办差、诸司协办、专家会审、蜂群并行、后台值房、上官归属与会话目标。
- Icons and interaction states: app controls use the existing Phosphor icon family; chips and officials expose selected, hover, focus, live, completion, review, and failure states. Buttons retain semantic labels and visible keyboard focus.
- Responsiveness and accessibility: the main grid collapses for narrower windows, the roster scrolls horizontally, all officials are buttons, reduced-motion disables bobbing/transitions, and long dynamic text truncates into the detail surface.

## Comparison history

### Iteration 1

- P1: external SVG `<use>` references left all official illustrations invisible, so the page showed only desks and labels.
- Fix: promoted the supplied official artwork into six standalone robe-color SVG assets and rendered them as normal images.
- Post-fix evidence: `/Users/yin/Documents/ybs/code/proxy/kimiwork/kimi-code/.tmp/design-qa/liubu-implementation-1280x820.png` shows all six desk officials plus the overflow official, with sharp outlines and correct department colors.

### Iteration 2

- P2: the first implementation capture used a 1280 × 720 viewport while the source used 1280 × 820, making vertical proportions incomparable.
- Fix: set the browser viewport override to 1280 × 820 and recaptured both source and implementation at device scale factor 1.
- Post-fix evidence: the normalized full-view pair has identical pixel and CSS dimensions; stage, sidebar, and above-the-fold content can be compared directly.

## Verification

- Primary interactions: agent chip selection, stage-agent selection, parent attribution, and child-agent conversation CTA visibility passed.
- Browser console: no render or runtime errors. Only Vite connection/debug and React development notices were present.
- Desktop TypeScript checks: passed.
- Desktop tests: 160/160 passed.
- Desktop production build: passed.

final result: passed

---

# Desktop application and installer icon — design QA

## Evidence

- Source visual truth: `/Users/yin/.codex/generated_images/019fe688-e361-7d43-89ad-68be4204f43b/exec-d9deda75-59e6-46a5-b432-c0f1d9498835.png` (1488 × 1314 px), specifically the large Folded K icon at the left of the selected design board.
- Implementation screenshot: `apps/kimi-desktop/.tmp/icon-package-smoke/packaged-icon.png` (1024 × 1024 px), rendered from the `icon.icns` embedded in the unpacked macOS application.
- Full-view comparison: `.tmp/icon-generation/source-vs-packaged-icon.png` (1040 × 540 px), with the selected source icon and packaged icon normalized to adjacent 500 × 500 px regions.
- Focused-region comparison: `.tmp/icon-generation/icon-size-contact-sheet.png` (880 × 640 px), rendering the production PNG at 256, 128, 64, 32, and 16 px over both light and dark surfaces.
- Viewport: normalized 500 × 500 px icon comparison; small-size checks at native output sizes.
- Density normalization: the source icon crop was centered without distortion; the packaged 1024 px icon was downsampled to the same 500 px comparison region. Small-size checks use native 1× pixels.
- State: standalone application icon with transparent exterior; macOS app bundle packaged for arm64 with the production `icon.icns`.

## Findings

No actionable P0, P1, or P2 differences remain.

- The packaged asset preserves the selected mark: deep navy rounded-square tile, cobalt rim, blue folded upper ribbon, violet lower ribbon, translucent crossing, and lower-right violet glow.
- The production master uses platform-appropriate transparent padding around the rounded square. This intentionally differs from the edge-filling presentation on the design board and matches the Dock-scale example in that same board.
- The embedded `icon.icns` is byte-identical to the configured build asset. The application bundle declares `CFBundleIconFile = icon.icns`.
- Alpha inspection reports fully transparent corners and no visible chroma-key fringe. The mark stays identifiable at 16 px on light and dark backgrounds.

## Required fidelity surfaces

- Fonts and typography: not applicable; the icon contains no text or typographic glyphs.
- Spacing and layout rhythm: the mark remains centered with even platform-safe padding, consistent corner radii, and no crop at any tested size.
- Colors and visual tokens: the navy, cobalt, electric blue, periwinkle overlap, and violet palette match the selected source direction.
- Image quality and asset fidelity: the 1024 px RGBA master is sharp and halo-free; `.icns` and `.ico` contain the required multi-resolution representations, while Linux uses the full-resolution PNG.
- Copy and content: no copy is present; the only content is the selected Folded K mark.

## Comparison history

### Iteration 1

- No P0/P1/P2 visual mismatch was found in the first normalized comparison, so no post-QA visual correction was required.
- Packaging verification confirmed that the rendered `.app` icon exactly matches the configured `.icns` asset.

## Verification

- Desktop tests: 153/153 passed.
- Desktop TypeScript checks: passed.
- Desktop production build: passed.
- Electron macOS arm64 unpacked package: passed.
- Electron macOS arm64 DMG build and read-only mount: passed; both `.VolumeIcon.icns` and the embedded app icon are byte-identical to the configured production asset.
- Packaged icon declaration and byte identity: passed.
- Small-size light/dark visual check: passed at 256, 128, 64, 32, and 16 px.

final result: passed
