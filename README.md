# F1 Driving v9

Lokální multiplayerová závodní hra Formule 1 pro 1 až 8 hráčů (nebo 1 hráče + až 7 AI botů) na telefonech připojených ke stejné Wi-Fi síti. Hra nepotřebuje žádný účet, přihlášení ani připojení k internetu. Jeden telefon s aplikací Termux slouží jako hostitelský server.

Verzi v9 poznáte v lobby podle nápisu „v9 – AI boti, 4 obtížnosti a plnohodnotné závody i v 1 hráči" a podle voliče počtu AI botů (0 až 7). Pokud tento nápis nevidíte, neběží tato verze, ale starý server nebo cachovaná stránka v Chromu, viz Řešení problémů níže.

## Hraní online (Cloud Run)

Hra běží veřejně na adrese https://f1-driving-370222114337.europe-central2.run.app — stačí ji otevřít v prohlížeči na telefonu nebo počítači, zadat jméno a hrát. Žádná instalace ani stejná Wi-Fi není potřeba. První načtení po delší pauze může pár sekund trvat, než se server probudí (škáluje se na nulu, když nikdo nehraje).

## Spuštění v aplikaci Termux (krok za krokem)

Tento zip má složku `f1-driving/`, uvnitř jsou soubory `server.js`, `index.html`, `package.json` a `README.md`. Server umí načíst `index.html` jak z `f1-driving/public/index.html`, tak z `f1-driving/index.html`, takže funguje obě struktury.

1. Otevřete na hostitelském telefonu aplikaci **Termux** a nainstalujte Node.js a nástroj `unzip` (pokud je ještě nemáte):
   ```bash
   pkg install nodejs unzip
   ```

2. Rozbalte archiv `f1-driving.zip`:
   ```bash
   unzip -o f1-driving.zip
   ```

3. Přejděte do složky se souborem `server.js`:
   ```bash
   cd f1-driving
   ```
   Pokud jste zip rozbalili přímo ve složce, kde už `server.js` je, tento krok přeskočte. Poznáte to podle řádku v Termuxu: musí na něm být vidět, že jste ve složce, kde je `server.js`, například `~/downloads/f1-driving $`. Příkaz `ls` tam musí ukázat `server.js` a `index.html`.

4. Nainstalujte závislost (`ws`):
   ```bash
   npm install
   ```

5. Spusťte server:
   ```bash
   node server.js
   ```

6. Připojení hráčů v prohlížeči Chrome:
   - **Na hostitelském telefonu** (kde běží Termux) otevřete prohlížeč Chrome a zadejte adresu:
     `http://localhost:3000`
   - **Na ostatních telefonech** (všechny telefony musí být na stejné Wi-Fi síti) otevřete prohlížeč Chrome a zadejte lokální IP adresu vypsanou serverem v Termuxu:
     `http://<IP-adresa-hostitelskeho-telefonu>:3000` (například `http://192.168.1.50:3000`)
   - Hru nikdy neotevírejte přímo jako stažený soubor (`file://`). Vždy ji otevírejte přes adresu serveru v prohlížeči.

## Řešení problémů

- `npm error ENOENT` u `package.json` nebo `Cannot find module server.js` znamená, že příkaz neběží ve složce se `server.js`. Zkontrolujte řádek v Termuxu a příkazem `cd f1-driving` přejděte do správné složky, pak `npm install` a `node server.js` zopakujte.
- Server musí běžet po celou dobu hry. Termux nezavírejte, jen přepněte do Chromu.
- **Otevírá se stará verze hry:** nejčastěji běží ještě starý server na portu 3000. Nový server se pak vůbec nespustí, protože port je obsazený, a prohlížeč dál ukazuje starou hru. Postup: v Termuxu zastavte všechny staré servery příkazem `pkill node`, pak v jedné relaci spusťte `node server.js` a zkontrolujte, že výpis začíná „F1 Driving v2 server běží!". Teprve pak otevřete hru v Chromu. Pokud výpis v2 nevidíte, nový server neběží.
- **Chrome ukazuje starou stránku i po spuštění nového serveru:** otevřete hru v anonymním okně Chromu (nová anonymní karta), nebo v Chromu vymažte mezipaměť: Nastavení > Ochrana soukromí > Vymazat údaje o prohlížení > Obrázky a soubory v mezipaměti. Server od v2 posílá hlavičku no-store, aby se stará verze už neukládala do mezipaměti.
- **Více kopií hry v telefonu:** server na portu 3000 může běžet jen jeden. Pokud máte složky `f1-driving`, `faze2` i jiné kopie, spusťte vždy jen jeden server, a to z té složky, kterou chcete hrát. Smazání složky za běhu server nezastaví, server už má soubory načtené a dál obsluhuje starou verzi.

## Herní režimy, rychlost, počasí a sólo hra

Hostitel (první připojený hráč) v lobby nakreslí prstem uzavřenou trať (nebo vybere ukázkovou trať), zvolí herní režim, rychlost formulí a počasí a odstartuje závod na **3 kola**:

- **Časovka**: Všichni hráči jedou 3 kola. Pořadí se určuje podle celkového času. Závod končí, když dojedou všichni hráči.
- **Vyřazování**: Jakmile první hráč dokončí kolo odpovídající aktuálnímu vyřazovacímu kolu, poslední aktivní hráč v pořadí vypadává (`VYŘAZEN`). Pokud v závodě zůstane už jen jeden aktivní hráč, závod okamžitě končí (pro 2 hráče po 1. kole, pro 3 hráče po 2. kole, pro 4 hráče po 3. kole).
- **Výbuch**: Každé kolo se každému hráči počítají sekundy strávené mimo trať (`Mimo trať toto kolo: X.X s`), které se na začátku nového kola nulují. Při srážce dvou aktivních formulí vybouchne hráč, který má v aktuálním kole více sekund mimo trať (pokud je rozdíl nejvýše 0,05 s, nevybouchne nikdo). Vybuchlý hráč (`VYBOUCHL`) dále sleduje vedoucího závodníka.
- **Rychlost formulí**: `Pomalé` (0,7×), `Normální` (1,0×), `Rychlé` (1,3×).
- **Počasí na trati**: `Slunečno` (normální grip i rychlost), `Déšť` (grip 0,6×, tedy větší smyk než v2, a maximální rychlost 0,9×, mokrý lesklý asfalt, kapky deště a vodní tříšť za koly), `Mlha` (viditelnost 50 %: viditelný výřez kamery kolem vlastního auta se zmenší na polovinu, soupeři mimo tento dosah se nekreslí a minimapa ukazuje jen vlastní auto).
- **Sólo hra**: Pokud je v lobby jen 1 hráč, je možná jen Časovka na 3 kola. Vyřazování a Výbuch jsou v lobby při 1 hráči nedostupné. Po dojezdu se ukáže celkový čas, časy kol a nejlepší kolo.

## Zvuk (nové ve v3, upraveno ve v4)

Zvuk je generovaný přímo v prohlížeči přes WebAudio, žádné zvukové soubory se nestahují. Není to nahrávka skutečné formule, je to syntetizovaný zvuk, který se motoru blíží víc než v3:

- **Motor (v4 hlasitější a plnější)**: tři oscilátory najednou – základní tón, oktáva a hluboký sub – přes jemné zkreslení (výfuk) a lowpass filtr. Tón stoupá s rychlostí, při plynu je hlasitější. Hlasitost: plyn 0,22, bez plynu 0,10, proti v3 (0,07 / 0,03) zhruba 3× vyšší, s kompresorem proti přebuzení. Hraje jen během závodu, ne v lobby ani po dojezdu.
- **Déšť (nové ve v4)**: šum deště přes lowpass filtr, hlasitost 0,10. Hraje jen když je zvolené počasí Déšť a jen během odpočtu a závodu, ne v lobby a ne po dojezdu.
- **Odpočet**: nízký tón při odpočtu, vysoký tón při poslední sekundě a při GO.
- **Dojezd**: krátká melodie čtyř tónů po dojezdu závodu.
- **Vypnutí**: v závodě je v horním panelu tlačítko „Zvuk: zapnuto / vypnuto", vypne motor i déšť najednou. Pokud zvuk po startu nehraje, prohlížeč ho zablokoval do prvního dotyku – stačí klepnout na plyn nebo na volant, zvuk se pak zapne. Zkontrolujte i hlasitost médií v telefonu.

## Hra až v 8 hráčích (nové ve v5)

- Lobby přijme až 8 hráčů, 9. hráč dostane hlášku „Lobby je plná (maximálně 8 hráčů)."
- Barvy: červená, modrá, žlutá, zelená, oranžová, fialová, tyrkysová, růžová.
- Startovní rošt: 1–4 hráči jedou v jedné řadě jako dřív. 5–8 hráčů jede ve dvou řadách, první 4 na startu, zbytek o 16 bodů trati za startem (asi 75 jednotek, víc než kolizní vzdálenost 26).
- Vyřazování pro více hráčů: v posledním kole vedoucí dojel, takže vypadnou všichni zbylí soupeři. Jinak se vyřazení rozdělí rovnoměrně na zbývající kola: 4 hráči 1,1,1; 6 hráčů 2,2,1; 8 hráčů 3,2,2 (poslední číslo je finální kolo). Časovka a Výbuch se pro 5–8 hráčů pravidly nemění.

## Nové ve v6

- **Dynamický výřez pro mrtvé hráče**: vyřazený i vybuchlý hráč už nesleduje jen vedoucího ani svoje mrtvé auto. Kamera se přizpůsobí všem ještě jedoucím autům – když jsou u sebe, je výřez blíž, když se rozjedou, oddálí se až na celou mapu. V mlze mrtvý hráč vidí všechna auta i na minimapě, jako televizní přenos.
- **Živý žebříček**: během závodu je pod minimapou seznam všech hráčů podle pořadí, s kolem a stavem (DOJEL / VYŘAZEN / VYBOUCHL).
- **Startovní semafor**: místo čísel odpočtu se rozsvěcí 5 červených světel, pak GO!
- **Zvukové předvolby (jen pro tebe, v lobby)**: F1, V8, Elektro. U F1 a V8 otáčky v rámci převodového stupně rostou a při přeřazení spadnou, Elektro je plynulý bez řazení.
- **Zvuk srážky a výbuchu**: krátký náraz při srážce (max 1× za 0,5 s na dvojici) a delší výbuch při explozi auta.
- **Zvuk: zapnuto / vypnuto – ověřeno**: tlačítko je v horním panelu závodu. Ve v5 bylo neklikatelné, protože horní panel měl `pointer-events: none`. Ve v6 má tlačítko `pointer-events: auto`, takže na něj jde klepnout. Vypnutí nastaví hlasitost motoru i deště na 0 a zablokuje i tóny, srážku a výbuch; zapnutí zvuk vrátí při dalším stavu ze serveru.

## Nové ve v7

- **Velikost mapy (volba hostitele)**: Standardní 1600 × 900 jako dřív, nebo Velká 2400 × 1350 (1,5×). Změna velikosti mapy zruší nakreslenou trať, hostitel ji nakreslí znovu pro nový svět. Ukázková trať se škáluje podle velikosti světa.
- **Oblíbené tratě**: hostitel si v lobby uloží aktuální trať pod jménem. Ukládá se do prohlížeče na tomto telefonu (localStorage), ne na server, takže oblíbené tratě vidí jen hostitel na svém telefonu. Načtení tratě pro jinou velikost mapy nejdřív přepne velikost mapy a pak trať nakreslí. Maximálně 20 oblíbených tratí, starší se přepisují.
- **Časomíra**: v živém žebříčku je u každého hráče nejlepší kolo, pokud už nějaké dokončil. Po dojezdu jsou u každého hráče statistiky: nejlepší kolo, maximální rychlost, čas mimo trať celkem a mezera k vítězi v sekundách (u nedojetých hráčů mezera —).
- **Kvalifikace (dobrovolná, volba hostitele)**: hostitel v lobby zvolí Rovnou závod, nebo Kvalifikace (1 kolo). Kvalifikace je časovka na 1 kolo bez vyřazování a bez výbuchu, s limitem 75 s. Po kvalifikaci se automaticky, po 6 s pauze s roštem, jede hlavní závod v nastaveném režimu. Startovní rošt je 2 auta v řadě, každá další řada je o alespoň 60 jednotek za startem, podle pořadí kvalifikace. Sólo hra kvalifikaci přeskočí a jede rovnou závod.
- **Minimapa se ve v7 nemění** na výslovné přání uživatele, i když na velké mapě budou tečky relativně menší, protože svět je větší a minimapa je stejná.

## Nové ve v8

- **Návrat na trať mimo trať**: když je živé auto mimo trať, hra ukáže žlutou šipku 160 px od středu obrazovky směrem k nejbližšímu bodu středové čáry, se vzdáleností v jednotkách, a v horním panelu se místo „MIMO TRAŤ" ukáže „MIMO TRAŤ – trať X j.". Šipka se ukazuje jen při vzdálenosti nad 80 jednotek, ne při pouhém dotyku s krajem silnice.
- **Oddálení kamery mimo trať**: za slunce a deště se kamera při vzdálenosti nad 200 jednotek od trati postupně oddálí, až 2×, aby byla trať vidět dřív. V mlze se kamera neoddálí, aby mlha nebyla obcházena, šipka ale funguje i v mlze.
- **Minimapa se ve v8 nemění.** Trať je načtená správně, jak ukazuje minimapa v každém snímku videa, problém byl v tom, že kamera sledovala jen auto a trať byla mimo záběr, když auto vyjelo do trávy a až k okraji světa, kde je pozadí mimo svět jednolité.

## Nové ve v9

- **AI boti (počítačoví protivníci)**: hostitel může v lobby přidat 0 až 7 AI botů (do celkové kapacity 8 vozů na startovním roštu). Boti mají jména pilotů F1 s předponou `[BOT]` (např. `[BOT] Verstappen`, `[BOT] Hamilton`, `[BOT] Leclerc`) a v lobby mají štítek `AI`.
- **4 úrovně obtížnosti botů**: `Lehká`, `Střední`, `Těžká` a `Smíšená` (každý bot na roštu má jinou úroveň rychlosti a chybovosti jako v reálném poli F1).
- **Inteligentní jízda a předjíždění**: boti na serveru pri 60 Hz vyhodnocují křivost nadcházejících zatáček na libovolné nakreslené trati, přibrzďují do ostrých oblouků a za deště a snaží se s bočním odstupem předjíždět pomalejší auta před sebou.
- **Plnohodnotné režimy i pro 1 hráče**: jakmile jsou na roštu alespoň 2 vozy (např. 1 člověk + 1 či více AI botů), odemknou se všechny herní režimy (**Časovka**, **Vyřazování**, **Výbuch**) i **Kvalifikace na 1 kolo**.
- **v9.3 – plynulost se 7 boty**: karoserie aut se předkreslí do spritu (jeden canvas na barvu/počasí), takže za snímek stačí jeden otočený `drawImage` místo ~8 gradientů na auto; auta mimo výřez kamery se nekreslí vůbec, gradienty počasí a podklad minimapy se cachují a HUD se aktualizuje max 10× za sekundu. Opravuje sekání a ztrátu zatáčení při 7 botech (klient zpracovával jen ~12 stavů/s, server přitom posílal 60/s).
- **v9.4 – modernizace podle Modern Web Guidance**: Enter v poli jména nově ignoruje skládání znaku přes IME (`isComposing` / `keyCode 229`), takže hráče nepřipojí uprostřed psaní; mazání obsahu seznamů přes `replaceChildren()` místo `innerHTML = ''` (žádný HTML parser, připraveno na Trusted Types); řazení polí přes `toSorted()` / `toReversed()` místo kopírování přes `slice()`.

## Ovládání

- **Volant (vlevo dole)**: Absolutní volant se žlutou značkou směru jízdy. Formule jede směrem, kam ukazuje žlutá značka na obrazovce (nahoru = na sever). Po puštění zůstává volant natočený v posledním směru.
- **Plyn (vpravo dole)**: Jediný pedál plynu. Zpátečka ani brzda ve hře nejsou – po puštění plynu formule zpomaluje odporem prostředí.
- **Klávesnice (pro testování na počítači)**: Šipka vlevo a vpravo otáčí cílovým směrem volantu, šipka nahoru přidává plyn.

## Vzhled

Pohled shora s pseudo-3D detaily: tráva s pruhy, stromy mimo trať, pneumatikové stěny podél trati, boxová ulička u startovní rovinky, startovní brána, stíny formulí a detailní formule F1 s halem, helmou a křídly. Tribuna u startu byla ve v6 odstraněna. Vybuchlá formule se ukáže jako vrak s kouřem.
