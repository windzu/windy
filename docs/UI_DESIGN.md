# Windy UI design

## Direction

Windy combines three complementary qualities:

- Notion AI's calm shell, empty state, and composer hierarchy.
- Claudian's readable execution details for long-running tool work.
- Wind's handwritten mark and restrained warm accent.

The interface remains native to Obsidian. It uses Obsidian theme variables,
supports light and dark themes, and avoids hard-coded application surfaces.

## Information architecture

### Header

- The conversation title is the primary navigation control.
- A dedicated new-conversation action remains visible at all times.
- The active page appears once as a compact context chip.
- Opening the view never creates a conversation.

### Empty state

- The Wind mark establishes identity without taking over the panel.
- A short sentence explains that the current page is already in context.
- Four explicit starter actions create a conversation only when selected.

### Transcript

- User requests are compact and visually distinct.
- Assistant answers use the full reading width without a surrounding card.
- Reasoning and tool calls form one ordered, collapsible activity trail.
- Active work keeps the activity trail collapsed and surfaces only the current
  action in its summary; the full trail remains manually expandable.
- Terminal turns collapse to a duration and activity-count summary.
- Codex activity renders concise, user-facing reasoning summaries; raw model
  reasoning is not part of the transcript.
- Activity labels are derived locally from normalized tool metadata rather
  than generated through an additional model request.
- Running, completed, blocked, and failed states remain distinguishable.

### Composer

- Context chips, textarea, and actions live inside one bounded surface.
- The primary page is pinned; additional pages can be added with `@`.
- Model selection stays visible, while provider-specific detail stays in menus.
- Send and stop share one primary action position.

## Visual tokens

Windy defines local tokens that fall back to Obsidian theme values:

- Brand accent: `#d97757`
- Light brand surface: `#faf9f5`
- Spacing rhythm: 4, 8, 12, 16, 24 pixels
- Surface radius: 12 to 16 pixels
- Borders: one pixel, low contrast
- Shadows: reserved for the floating entry and popovers

The brand accent is used for focus, active work, and the floating entry. It is
not used as a large background or for ordinary body text.

## Interaction states

- `idle`: composer ready; no status label required.
- `running`: animated status, stop action, context controls disabled.
- `waiting-approval`: approval card and highlighted activity state.
- `waiting-input`: inline questions in the scrollable transcript and a
  highlighted activity state until the user responds.
- `completed`: stable transcript; composer ready for a follow-up.
- `failed` or `interrupted`: recovery treatment adjacent to the composer.

## Responsive and accessibility requirements

- Remain usable from 320 to 600 pixels of panel width.
- Never clip the model label, page chip, or send action at 320 pixels.
- Preserve visible focus states and native keyboard behavior.
- Provide text alternatives for icon-only controls.
- Use theme-compatible foregrounds and backgrounds in light and dark modes.

## Acceptance checklist

- Opening Windy does not create a conversation.
- The current page is visible exactly once in the shell or composer.
- Empty-state actions create a conversation only after an explicit click.
- The composer remains reachable while the transcript scrolls independently.
- Tool states are readable when collapsed.
- The custom Wind mark appears in the view, ribbon, and floating entry.
- Light and dark screenshots are reviewed at 320, 420, and 560 pixel widths.
