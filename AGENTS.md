# Development guidelines

## Solutions that work across websites

This application works across different websites and automation types. Base new
features and bug fixes on browser behavior shared across websites.

- Do not fix a bug by tying the solution to the domain, URL pattern, CSS class,
  listing title, or fixed page text of the website where it was observed.
- Loading, reading, waiting, and recovery must use the same logic across
  websites. Use general DOM and accessibility information, currently observed
  controls, and the content required by the task.
- An open page does not mean the requested content is ready. Do not treat an
  incomplete load as an empty result, an unsuitable record, or a completed read.
- Waits and retries must be bounded, cancellable, and scoped to the task and
  tab. Do not repeatedly send unchanged content to the model or restart an
  ongoing load by reopening the page.
- Validate fixes against different URL formats and page structures, delayed
  content, genuinely short content, and loads that never complete. Preserve
  automations beyond job listings and avoid disrupting other workers.
- If the shared mechanism cannot retrieve the content, report that clearly.
  Do not assume missing content or a successful result. Add an exception for a
  particular website only when the user explicitly requests it.

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for other development and validation
steps. Keep temporary page content and the Jev cache in RAM; read pages again
after the application restarts.
