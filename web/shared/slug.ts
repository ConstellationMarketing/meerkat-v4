// Shared slug helpers used by the SEO view (client) and update-article (server).

/** Normalize any user input into a valid slug: lowercase, hyphenated, safe chars. */
export function slugify(input: string): string {
  return (input || '')
    .toLowerCase()
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Lenient transform for live typing in an input: lowercases and converts spaces
 * to hyphens, but KEEPS hyphens (including a trailing one mid-typing) so the
 * user can actually type "-". Run the strict slugify() on save/blur.
 */
export function slugifyInput(input: string): string {
  return (input || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

export interface SlugValidationResult {
  valid: boolean;
  errors: string[];
}

export interface SlugValidationOptions {
  pageType?: string; // e.g. "Practice Page" | "Supporting / Resource Page"
  hubPath?: string;  // optional hub path for spoke pages
}

/**
 * Validate a slug against basic format rules + the hub/spoke URL rules.
 *
 * Format rules are implemented. The hub/spoke + Slug SOP rules are stubbed
 * below with a clearly-marked TODO — drop the exact rules from the Slug SOP
 * into enforceHubSpokeRules() and they take effect on both client and server.
 */
export function validateSlug(
  slug: string,
  opts: SlugValidationOptions = {},
): SlugValidationResult {
  const errors: string[] = [];
  if (!slug) errors.push('Slug cannot be empty.');
  if (slug.length > 75) errors.push('Slug must be 75 characters or fewer.');
  if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    errors.push(
      'Use only lowercase letters, numbers, and single hyphens (no spaces, special characters, or leading/trailing hyphens).',
    );
  }
  enforceHubSpokeRules(slug, opts, errors);
  return { valid: errors.length === 0, errors };
}

/**
 * TODO(Slug SOP): implement the hub/spoke URL rules here once the Slug SOP is
 * provided. Examples of what will likely go here:
 *   - Supporting/"spoke" pages must be nested under their practice/"hub" path.
 *   - Required or forbidden path segments/prefixes.
 *   - Client-level uniqueness (needs a DB check — enforce that server-side).
 * Until then this is a no-op so format validation still works.
 */
function enforceHubSpokeRules(
  _slug: string,
  _opts: SlugValidationOptions,
  _errors: string[],
): void {
  // no-op placeholder
}
