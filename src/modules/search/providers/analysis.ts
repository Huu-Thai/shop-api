/** Language for stemming, by locale — shared by the Elasticsearch/OpenSearch mappings. */
const STEMMERS: Record<string, string> = {
  en: 'english',
  de: 'german',
  fr: 'french',
  es: 'spanish',
  it: 'italian',
  nl: 'dutch',
  pt: 'portuguese',
  sv: 'swedish',
  da: 'danish',
  fi: 'finnish',
  no: 'norwegian',
  ru: 'russian',
  tr: 'turkish',
  id: 'indonesian',
};

export const stemmerFor = (localeCode: string): string | undefined =>
  STEMMERS[localeCode.split('-')[0].toLowerCase()];
