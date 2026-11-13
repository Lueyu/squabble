# Implemented findings

| Code | Deterministic evidence | Standard repair |
|---|---|---|
| H_OVERFLOW | Document width exceeds viewport by >2px (P0); a control exceeds a clipping ancestor, viewport or its article card by >2px (P1). | Allow the flex child to shrink, wrap the action group, or wrap its label within the existing container. Preserve intentional scrolling. |
| TAP_TARGET | The smaller effective hit dimension is <24px. An associated or enclosing visible label contributes its actual hit bounds. | Expand the real button box or connect a sufficiently sized clickable label. A standalone visual checkbox needs a real label target. |
| BTN_WRAP | Visible button text occupies more than one text line; explicitly normal multiline text with sufficient natural height and no internal clipping is intentional. Hidden accessibility text is excluded. | Permit the surrounding action group to wrap, or use an explicitly normal, naturally sized multiline button; avoid hidden content and arbitrary fixed widths. |
| MISALIGN_TOP | Declared actions in sibling friend cards in one grid row differ by >2px. | Make equal-height cards a column and place the action/footer group after an automatic flexible spacer. |
| MISALIGN_BOTTOM | Declared closed details in sibling friend cards in one grid row differ by >2px. | Keep actions and details together in the card footer so variable descriptions do not move the footer independently. |

Alignment is a declared card contract, not a scan of arbitrary parent/child
pairs. Selectors support both direct and nested card footers; a missing declared
target fails the scenario. Expanded memory/details and modal states do not have
the closed-card alignment contract. Repairs must cite a finding and its metric.
