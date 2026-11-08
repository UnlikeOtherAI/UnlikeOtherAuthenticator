import { describe, expect, it } from 'vitest';
import { billingOrganisationModeCopy } from './billing-organisation-mode-copy';

describe('organisation billing mode operator copy', () => {
  const english = billingOrganisationModeCopy('en-GB');
  it('uses the same complete English copy for both supported English locales', () => {
    expect(billingOrganisationModeCopy('en-US')).toEqual(english);
    expect(english.effect).toContain('remain pending until reconciled');
  });
  it.each(['cs-CZ', 'de-DE', 'es-ES', 'fr-FR', 'it-IT'])(
    'translates the doorway, save/recovery controls and every financial blocker for %s', locale => {
      const copy = billingOrganisationModeCopy(locale);
      for (const key of ['tab', 'doorway', 'defaultMode', 'title', 'live', 'sandbox', 'effect',
        'save', 'saved', 'retry', 'loadError', 'saveError', 'blocked'] as const) {
        expect(copy[key]).toBeTruthy();
        expect(copy[key]).not.toBe(english[key]);
      }
      expect(Object.keys(copy.blockers)).toEqual(Object.keys(english.blockers));
      for (const key of Object.keys(english.blockers)) {
        expect(copy.blockers[key]).toBeTruthy(); expect(copy.blockers[key]).not.toBe(english.blockers[key]);
      }
    });
});
