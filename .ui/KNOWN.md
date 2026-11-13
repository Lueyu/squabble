# Scope and exemptions

- Horizontal `overflow-x:auto/scroll` ancestors with real scrollable content and
  explicit `data-intent-scroll` areas are intentional. Holdings tables and
  section/filter tabs may scroll; that is not document overflow.
- Canvas, explicit `data-ui-probe-ignore`, hidden/inert DOM and third-party
  origins are outside the probe. Disabled visible controls remain measurable.
- Effective hit bounds use visible associated/enclosing HTML labels. This is
  a geometry check, not a complete WCAG target-spacing or accessibility audit.
- The probe measures the five codes in the dictionary. It does not implement
  contrast, occlusion, visual hierarchy, content quality, image stretching,
  cross-page style consistency, pixel-diff approval or aesthetic judgments.
- All data is fictional. Empty inventories and unverified external capabilities
  do not prove production data, provider, authentication or execution behavior.
- Source hints identify the owning component, not a precise source-map line.
- The route matrix is finite. New pages, states and viewport changes require a
  new before capture; no production coverage is inferred beyond those entries.
- No formal UI baseline has been approved. Before/after JSON and screenshots are
  evidence only. Human approval is required for any future formal baseline.
