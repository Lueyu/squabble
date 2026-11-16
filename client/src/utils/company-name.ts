/**
 * Choose an existing English name from a bilingual company label for English UI.
 * Keep single-language/custom names intact: presentation must not rewrite records
 * or guess a company's identity. Missing names and ticker duplicates are omitted.
 */
export function displayCompanyName(
  company: string | null | undefined,
  ticker: string,
  language: string,
): string | null {
  const name = (company ?? '').trim();
  if (!name) return null;
  const base = (value: string): string => value.split('.')[0].toUpperCase();
  if (base(name) === base(ticker)) return null;

  if (language.startsWith('en')) {
    const bilingual = name.match(/^(.*?)\s*[(（]([^()（）]+)[)）]$/u);
    if (
      bilingual &&
      /\p{Script=Han}/u.test(bilingual[1]) &&
      /[A-Za-z]/u.test(bilingual[2]) &&
      !/\p{Script=Han}/u.test(bilingual[2])
    ) {
      return bilingual[2].trim();
    }
  }
  return name;
}
