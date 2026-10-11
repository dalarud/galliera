# ♛ Vill du investera som kungen?

En fiktiv skuggportfölj som följer **Gallierafonden**, H.M. Konungens egen aktieportfölj. Sidan läser
nyheter om fondens köp och sälj, gör samma affärer i en fiktiv fond och visar uppskattade innehav,
kassa och utveckling (andelsvärde) mot OMX Stockholm PI eller OMXS30.

> Underhållning och utbildning. Ingen koppling till Kungliga Hovstaterna och inte investeringsrådgivning.

## Så fungerar det

```
Google News RSS ──► avkoda länk ──► läs artikel ──► tolka tabeller och köp/sälj
                                                     │
data/ledger.json ◄───────── nya händelser ◄──────────┘
       │
       ▼
Yahoo Finance (kurser + utdelningar) ──► replikeringsmotor ──► data/portfolio.json ──► index.html
```

1. **Nyhetsbevakning** (`scripts/lib/news.mjs`): söker med ett tiotal svenska frågor ("Gallierafonden",
   "kungens aktier", …), filtrerar fram artiklar om kungen och aktier, avkodar Google News-länken till
   publicistens URL och läser artikeln. Är sidan låst tolkas rubrik och ingress.
2. **Tolkning** (`scripts/lib/parse.mjs`):
   - *Innehavstabeller* (≥ 5 bolag med antal aktier) blir en avstämning som skriver över innehaven.
   - *Meningar* som "sålt hela innehavet i Handelsbanken", "halverat Industrivärden" eller "tagit in
     29 000 aktier i Beijer Ref" blir affärer. Antal aktier och belopp läses ut, liksom månad ("i september").
   - Meningar om Gluonen eller kungabarnens portföljer, rena kursnyheter och fall där ett bolag självt
     köper ("Investor köper aktier i EQT") hoppas över.
3. **Viktning mot innehavet** när antal saknas: en minskning motsvarar ⅓ av positionen, ett nytt bolag
   fondens medianvikt och ett utökat innehav +⅓. Affären märks då som *uppskattad*.
4. **Dubblettskydd**: en affär bokförs inte om den redan finns (samma bolag och riktning inom 45 dagar),
   om innehavet redan är sålt eller köpt, eller om en senare innehavstabell redan täcker den.
5. **Replikeringsmotor** (`scripts/lib/engine.mjs`): spelar upp affärsboken dag för dag till
   stängningskurs. Försäljningar och utdelningar går till kassan och köp dras därifrån. Räcker inte kassan
   bokförs mellanskillnaden som kapitaltillskott. Fonden räknas i andelar (start 100 kr), så avkastningen
   är tidsviktad och kan jämföras rakt av med index.

## Kom igång

Kräver Node 20 eller senare. Inga beroenden.

```bash
npm start            # http://localhost:8080 – kurser var 5:e min, nyheter var 15:e min
npm run update       # en körning: skanna nyheter + räkna om
npm run prices       # bara kurser
npm test
```

Intervallen kan ändras med `PORT`, `PRICE_MINUTES` och `NEWS_MINUTES`. Sidan själv hämtar
`data/portfolio.json` varje minut och uppdateras utan omladdning.

### Publicera med GitHub Pages

1. *Settings → Pages → Deploy from branch* och välj `main` / root.
2. Workflowen `.github/workflows/update.yml` kör uppdateringen var 15:e minut under börsens öppettider
   (och varje timme i övrigt) och committar nya data. Den kan också köras manuellt via *Actions*.

## Data

| Fil | Innehåll |
|---|---|
| `data/ledger.json` | Affärsboken: startportfölj, innehavstabeller, affärer och avknoppningar, med källa och om uppgiften är *rapporterad* eller *uppskattad*. Automatiska händelser har `"auto": true`. Sätt `"disabled": true` för att stänga av en feltolkad händelse. |
| `data/securities.json` | Bolag, Yahoo-ticker och namnvarianter som skannern känner igen. Lägg till fler här. |
| `data/news.json` | Alla skannade artiklar och hur de tolkades. |
| `data/portfolio.json` | Genererad: tidsserie, innehav, affärer, kassaflöden och nyheter. |

### Startdata (verifierade källor)

- **7 nov 2025**: fullständig lista med 17 bolag, 74,7 Mkr ([Placera](https://www.placera.se/nyheter/kungen-ager-alla-storbanker-utom-en--investor-familjens-favorit-2025-11-10)).
- **25 apr 2026**: tio största innehaven, portföljen ≈ 107 Mkr ([Börskollen/DI](https://www.borskollen.se/nyheter/27/kungens-portfolj-upp-73-procent-pa-ett-ar-har-ar-hans-favoritaktier)).
  Antal i nytillkomna Latour, Elekta och Sweco är uppskattade, och Svolder är kalibrerad mot totalen.
- **Sep 2026**: Investor −8 000, Industrivärden −15 100, Handelsbanken ut, EQT +25 600, Beijer Ref +29 000;
  **8 okt 2026**: fullständig lista med 19 bolag ([Placera](https://www.placera.se/nyheter/kungafamiljen-minskar-i-investor--tar-in-eqt--2026-10-09)).

### Begränsningar

- Fondens verkliga kassa är inte offentlig. Kassan är en modell som startar på 0 kr.
- Holdings-data publiceras med fördröjning och exakta affärsdatum saknas ofta (då används den 15:e i månaden).
- Kurser kommer från Yahoo Finances öppna API, som kan vara fördröjt eller ändras.
