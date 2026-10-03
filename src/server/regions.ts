/**
 * Dashboard regions: named groups of ISO 3166-1 alpha-2 country codes that can be used as a scope next to single
 * countries. Codes are 3+ letters so they never collide with a country code (`me` is Montenegro).
 * Every country belongs to at most one region; Mexico, Central America and the Caribbean count as Latin America.
 */
export interface Region {
  code: string;
  label: string;
  countries: readonly string[];
}

const list = (s: string): readonly string[] => s.trim().split(/\s+/);

export const REGIONS: readonly Region[] = [
  {
    code: 'latam',
    label: 'Latin America',
    countries: list(`
      MX GT BZ HN SV NI CR PA CU DO HT JM PR TT BB BS AG DM GD KN LC VC AW CW SX BQ TC KY VG VI AI MS GP MQ BL MF
      CO VE EC PE BO BR PY UY AR CL GY SR GF FK`),
  },
  { code: 'noram', label: 'North America', countries: list('US CA GL BM PM') },
  {
    code: 'europe',
    label: 'Europe',
    countries: list(`
      AL AD AT BY BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU
      SM RS SK SI ES SE CH UA GB VA GI IM JE GG FO AX SJ`),
  },
  { code: 'mideast', label: 'Middle East', countries: list('TR SA AE IL IR IQ JO KW LB OM QA SY YE BH PS') },
  {
    code: 'asia',
    label: 'Asia',
    countries: list(`
      CN JP KR KP TW HK MO MN IN PK BD LK NP BT MV AF KZ KG TJ TM UZ TH VN MY SG ID PH KH LA MM BN TL GE AM AZ`),
  },
  {
    code: 'africa',
    label: 'Africa',
    countries: list(`
      DZ AO BJ BW BF BI CM CV CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU MA MZ
      NA NE NG RW ST SN SC SL SO ZA SS SD TZ TG TN UG ZM ZW EH RE YT SH`),
  },
  { code: 'oceania', label: 'Oceania', countries: list('AU NZ FJ PG SB VU NC PF WS TO TV KI NR FM MH PW CK NU TK AS GU MP WF') },
];

const byCode = new Map(REGIONS.map((r) => [r.code, r]));

export function regionByCode(code: string | null | undefined): Region | undefined {
  return code ? byCode.get(code.toLowerCase()) : undefined;
}
