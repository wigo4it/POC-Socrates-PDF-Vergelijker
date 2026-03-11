# POC Socrates PDF Vergelijker 🔍

Een krachtige PDF-vergelijkingstool die **tekstanalyse** combineert met **visuele diffing**, geïnterpreteerd door de visuele intelligentie van **Claude AI**.

Binnen de Socrates-context helpt deze tool bij het valideren van document-engines, bijvoorbeeld door te controleren of nieuwe rapporten of brieven inhoudelijk en visueel consistent blijven met de originele versies.

## 🌟 Kenmerken

- **Hybride Analyse**: Gebruikt zowel tekstuele extractie (`pdf-parse`) als hoogwaardige pagina-rendering.
- **Tekstuele Precisie**: Identificeert exact toegevoegde of verwijderde regels tekst via een regelsgewijze `diff`.
- **Visuele Details**: Detecteert verschuivingen in layout, lettertypes en marges op pixel-niveau met `pixelmatch`.
- **AI-Interpretatie door Claude**: Stuurt rapporten en visuele snapshots direct naar Claude om te bepalen of wijzigingen acceptabel zijn (bijv. een tabel die over twee pagina's splitst is *niet* acceptabel).
- **Consistente Diagnosticering**: Geeft een gestructureerd JSON-antwoord met een reden voor de (dis)acceptatie van de wijzigingen.

## 🚀 Installatie

1.  Zorg dat Node.js (v18+) is geïnstalleerd.
2.  Installeer de benodigde dependencies:
    ```bash
    npm install
    ```
3.  Configureer je `.env` bestand met je API-sleutel:
    ```env
    ANTHROPIC_API_KEY=jouw_api_sleutel_hier
    ANTHROPIC_MODEL=claude-haiku-4-5-20251001
    ```

## 📖 Gebruik

Vergelijk twee PDF-bestanden met het volgende commando:

```bash
node index.js <pad-naar-pdf1> <pad-naar-pdf2> [output-map]
```

### Parameters:
- `<pad-naar-pdf1>`: Pad naar het originele of referentiedocument.
- `<pad-naar-pdf2>`: Pad naar de nieuwe versie van het document.
- `[output-map]` (Optioneel): De map waar visuele verschillen worden opgeslagen. Standaard is dit `./diff_output`.

### Voorbeeld:
```bash
node index.js brief_v1.pdf brief_v2.pdf resultaten
```

Na elke run wordt een machine-leesbaar rapport geschreven naar:

`<output-map>/comparison_report.json`

## 🛠️ Hoe het Werkt

1.  **Extractie & Rendering**: De tool haalt de ruwe tekst op en rendert elke pagina naar een PNG op hoge resolutie.
2.  **Vergelijk Tekst**: Een regel-voor-regel vergelijking legt inhoudelijke wijzigingen vast.
3.  **Vergelijk Visueel**: Pixelgegevens worden vergeleken om verschuivingen in de layout te vangen.
4.  **AI Analyse**: De tekstuele verschillen en de originele pagina's (naast elkaar) worden naar Claude gestuurd. Claude bepaalt of de wijzigingen "significant" zijn voor een menselijke lezer (bijv. "Inhoudelijk gelijk, maar de tabel is nu onleesbaar verdeeld over twee pagina's").

## ⚙️ Configuratie

De tool ondersteunt de volgende environment variabelen:

- `SCREENSHOT_SCALE` (default: `2.0`)
- `PIXELMATCH_THRESHOLD` (default: `0.1`)
- `MAX_AI_PAGES` (default: `3`)
- `TEXT_DIFF_SNIPPET_CHARS` (default: `2000`)
- `AI_MAX_TOKENS` (default: `1500`)
- `AI_TIMEOUT_MS` (default: `30000`)
- `REPORT_FILE_NAME` (default: `comparison_report.json`)

Voorbeeld:

```env
ANTHROPIC_API_KEY=jouw_api_sleutel_hier
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
MAX_AI_PAGES=3
PIXELMATCH_THRESHOLD=0.1
AI_TIMEOUT_MS=30000
```

## 📦 Resultaatformaat

Het JSON rapport bevat onder andere:

- `status`, `exitCode`
- `inputs`
- `timings`
- `textDiff`
- `visualDiff`
- `ai`
- `policy`

Hiermee kun je runs automatisch verwerken zonder console output te parseren.

## 🚦 Exit Codes

- `0`: `PASS`
- `2`: `WARN` (bijv. AI response ontbreekt of ongeldig)
- `3`: `FAIL` (bijv. page-count mismatch, dimensie mismatch, of AI afkeur)
- `4`: `ERROR` (input/uitvoering fout)

## ⚠️ Beperkingen & Tips

- **Afmetingen**: Visuele vergelijking werkt het best als de pagina-afmetingen gelijk zijn.
- **Token Besparing**: Om kosten te besparen stuurt de tool alleen de eerste 3 pagina's met visuele verschillen naar Claude voor gedetailleerde inspectie.
- **Threshold**: De visuele gevoeligheid staat momenteel op een drempelwaarde van 0.1 om ruis te voorkomen.
