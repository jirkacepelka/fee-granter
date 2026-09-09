# swap-and-grant — návrh kontraktu

## Kontext

`contracts/gas-vault` prodává gas credit **výhradně za nativní uscrt** přiložený jako
`info.funds` (`ExecuteMsg::Grant { grantee }`, částka čtená za běhu z `funds`). Kdo drží
sSCRT nebo stkd-SCRT, musí dnes nejdřív odwrapovat/prodat ve zvláštní transakci a teprve
pak nakoupit — dva podpisy a ruční odhad částky.

Ve statické Cosmos tx nejde částku ve zprávě 3 odvodit z výsledku zprávy 2 (`funds`
i `Redeem.amount` jsou pevná součást podepsaného těla). Runtime hodnotu umí přečíst
jedině kontrakt v `reply`. Proto executor.

Gas vault se **nemění**: drží cizí peníze a živé granty, migrace kvůli featuře je zbytečné
riziko. Executor je pro něj jen další platící adresa.

Cíl: koupit gas credit za sSCRT (fáze 1) a za stkd-SCRT přes ShadeSwap (fáze 2),
na jeden podpis, bez odhadování částek.

---

## 1. Ověřeno / neověřeno

Tahle sekce je první schválně. Chain se z tohohle sezení přečíst **nedal** — egress proxy
vrací 403 na všechny LCD endpointy i na `docs.shadeprotocol.io` a `shadejs.dev`.
Čtení zdrojáků přes `raw.githubusercontent.com` prošlo.

### Ověřeno čtením zdrojáku (`securesecrets/shadeswap`, `main`)

| Fakt | Kde |
| --- | --- |
| Router má `ExecuteMsg::Receive` (SNIP-20 callback), `SwapTokensForExact`, `RegisterSNIP20Token`, `RecoverFunds` (admin) | `contracts/router/src/contract.rs` |
| Payload v `Send.msg` je `InvokeMsg::SwapTokensForExact { expected_return, path, recipient }` | tamtéž, `receiver_callback` |
| `path` je `Vec<Hop>` (adresa páru + code hash); výstup hopu je vstup dalšího | tamtéž |
| **Router sám uvnitř používá `SubMsg::reply_always` se `SWAP_REPLY_ID`**, rozpracovaný swap drží v `CurrentSwapInfo { amount, amount_out_min, path, recipient, current_index, next_token_in }` | `router/src/operations.rs`, `router/src/state.rs` |
| Výstup jde na `recipient` (jinak odesílateli) přes `create_send_msg(...)` v `next_swap` | `operations.rs` |
| `expected_return` se kontroluje až na konci řetězu a při nesplnění **chybuje** → revert | `operations.rs` |
| Pár umí `SwapSimulation { offer, exclude_fee }` a `GetPairInfo` (`amount_0`, `amount_1`, `total_liquidity`, `fee_info`) | `contracts/amm_pair/src/contract.rs` |
| Router má `Config { viewing_key, admin_auth }` — sám si drží viewing key, stejný trik jako navrhujeme | `router/src/state.rs` |

### Ověřeno čtením zdrojáku (`scrtlabs/snip20-reference-impl`)

`Redeem { amount, denom: Option<String>, padding }` · `Send { recipient,
recipient_code_hash: Option<String>, amount, msg: Option<Binary>, memo, padding }` ·
`SetViewingKey { key, padding }` · `Balance { address, key }`.

### Ověřeno v repu

- V repu **nejsou** žádné adresy ani code hashe sSCRT, stkd-SCRT ani ShadeSwapu.
  Grep na `sscrt|snip-?20|shade|stkd|swap|viewing.?key` napříč `*.ts|*.tsx|*.rs|*.md`
  vrací jen `display: "swap"` v `layout.tsx` a jednu větu v `CLAUDE.md`.
  **Všechno se musí dohledat.**
- `chains.ts` už má tvar, do kterého to patří: registry klíčovaný `ChainId`,
  `gasVaultAddress` per chain, `configuredValue()` pro env override.

### Adresy z dokumentace — ke kontrole proti chainu, ne k okopírování

secret-4, dvojitě potvrzeno (SecretFoundation docs + `wrap.scrt.network/src/config.ts`):

| | adresa | code hash |
| --- | --- | --- |
| sSCRT | `secret1k0jntykt7e4g3y88ltc60czgjuqdy4c9e8fzek` | `af74387e276be8874f07bec3a87023ee49b0e7ebe08178c49d0a49c3c98ed60e` |
| stkd-SCRT | `secret1k6u0cy4feepm6pehnz804zmwakuwdapm69tuc4` | `f6be719b3c6feb498d3554ca0398eb6b7e7db262acb33f84a8f12106da6bbb09` |

ShadeSwap router secret-4 — **jednozdrojové, neověřené**: `secret1pjhdug87nxzv0esxasmeyfsucaj98pw4334wyc`,
code hash `448e3f6d801e453e838b7a5fbaa4dd93b84d0f1011245f0d5745366dadaf3e85`.
Před použitím přečíst z chainu (`secretcli q compute contract-hash <addr>`).

### Nezjištěno

- **Pár sSCRT/stkd-SCRT: adresa ani rezervy.** Odsud nepřečtu.
- **Existuje ShadeSwap na pulsar-3?** Nepotvrzeno ani nevyvráceno; v dokumentaci, kterou
  jsem viděl, žádný testnetový deployment není. **Předpokládej, že není**, dokud
  `ListAMMPairs` na factory neřekne opak.
- **sSCRT na pulsar-3.** Vyhledávání vrátilo dva rozporné kandidáty
  (`secret1gvn6eap7xgsf9kydgmvpqwzkru2zj35ar2vncj`, `secret1umwqjum7f4zmp9alr2kpmq4y5j4hyxlam896r3`),
  ani jeden s code hashem. Nespoléhat.

Až budeš mít síť, tyhle tři díry zavře:

```bash
secretcli q compute query <pair_addr>    '{"get_pair_info":{}}'
secretcli q compute query <factory_addr> '{"list_a_m_m_pairs":{"pagination":{"start":0,"limit":30}}}'
secretcli q compute contract-hash <router_addr>
```

---

## 2. Jeden kontrakt, nebo dva

**Jeden kontrakt, dvě větve v `Receive`, nasazený ve dvou fázích.**

- Ocas obou cest je identický — `Redeem`, `Grant`, nulový zůstatek, allowlist,
  code-hash pinning. Dva kontrakty = dvě kopie téhle části.
- Frontend: jedna adresa v `chains.ts`, jeden code hash v cache. Dvě adresy znamenají
  uživatelsky viditelnou otázku „kam mám poslat".
- Rozlišovací podmínka je triviální: `info.sender == sscrt` → přímá cesta,
  `info.sender ∈ routes` → swapová.

**Cena, otevřeně:** fáze 2 mění kód, takže fáze 1 musí být nasazená s migrate adminem,
aby šla povýšit na místě. Dva kontrakty by dovolily fázi 1 immutable. Beru to jako
přijatelné — v sekci 5 stejně vychází, že admin má být.

---

## 3. Entry pointy a zprávy

```
InstantiateMsg {
  gas_vault:   Contract { address, code_hash },      // NEMĚNNÉ
  sscrt:       Contract { address, code_hash },      // NEMĚNNÉ
  viewing_key: String,                               // NEMĚNNÉ
  admin:       Option<String>,                       // default = odesílatel
  router:      Option<Contract>,                     // až fáze 2
  routes:      Vec<(Contract /*token*/, Vec<Hop>)>,  // až fáze 2
}
```

Instantiate vrací jednu zprávu: `sscrt.SetViewingKey { key }`. Kontrakt neumí podepsat
permit, takže si klíč musí nastavit na sebe sám — přesně to dělá i ShadeSwap router.

```
ExecuteMsg {
  Receive { sender, from, amount, memo, msg },   // jediná vstupní brána
  SetRoute { token: Contract, path: Vec<Hop> },  // admin; prázdná path = odebrat token
  SetRouter { router: Contract },                // admin
  SetAdmin { admin: Option<String> },            // admin; None = zahodit napořád
  SweepToVault {},                               // bez oprávnění, viz 4.7
}
```

Payload v `Send.msg` (base64 JSON):

```
BuyCredit { grantee: String, min_out: Option<Uint128> }
```

`grantee` povinný a explicitní, stejně jako u vaultu. `Option` s defaultem na `from`
by při překlepu ve frontendu tiše zaplatil někomu jinému; `BuyCreditModal` má na to
už dnes tlačítko „Use my address".

```
QueryMsg { Config {}, Routes {}, Balances {} }   // Balances má být samá nula, viz I1
Reply id = 1 (SWAP_REPLY)                        // jediný; po replyi už žádný submessage není
```

---

## 4. Dvě cesty — kde přesně se liší

### 4a. sSCRT — bez swapu, bez replye

```
uživatel → sSCRT.Send { recipient: executor, msg: BuyCredit { grantee } }
  executor.Receive:
    info.sender == sscrt                       ✔ allowlist
    Response.messages = [                       // ne submessages
      sscrt.Redeem { amount },
      gas_vault.Grant { grantee } + funds: amount uscrt
    ]
```

Částku známe — je to `amount` z `Receive`. Nativní částka po `Redeem` je stejná, protože
sSCRT je 1:1 wrapper se shodnými desetinnými místy; to je jediné netriviální tvrzení téhle
větve a patří k němu assert (I4).

Obě zprávy jsou obyčejné `add_message`. Vykonají se sekvenčně, nativní SCRT dorazí dřív,
než vault sáhne na `funds`, a jakékoli selhání shodí celou tx včetně původního `Send`.

Samostatně nasaditelná fáze 1: kdo drží sSCRT, koupí credit na jeden podpis bez unwrapu.

### 4b. stkd-SCRT — jeden reply hop

```
uživatel → stkd.Send { recipient: executor, msg: BuyCredit { grantee, min_out } }
  executor.Receive:
    info.sender ∈ routes                       ✔ allowlist
    Pending není obsazené                      ✔ zámek (4.3)
    min_out je Some a nenulový                 ✔
    before := query sscrt.Balance { executor, vk }
    ulož Pending { grantee, before, min_out }  + zámek
    Response.submessages = [ SubMsg::reply_on_success(
      stkd.Send { recipient: router, msg: InvokeMsg::SwapTokensForExact {
        path: routes[stkd], expected_return: Some(min_out), recipient: executor } }, id=1) ]

  executor.reply(1, Ok):
    after    := query sscrt.Balance { executor, vk }
    received := after - before                 // ROZDÍL, ne parsování odpovědi routeru
    received >= min_out                        ✔ vlastní guard (4.2)
    zahoď Pending + zámek
    Response.messages = [ sscrt.Redeem { received },
                          gas_vault.Grant { grantee } + funds: received uscrt ]
```

**Jediné rozdíly proti 4a:** allowlist se dívá do `routes`; mezi `Receive` a ocas se vloží
jeden `reply_on_success` submessage; částka vzniká jako rozdíl zůstatku. Ocas
(`Redeem` + `Grant`) je bit po bitu tentýž kód, jen volaný z `reply`. To je celý argument
pro jeden kontrakt.

**Proč rozdíl zůstatku, a ne `return_amount`.** Kromě křehkosti cizího formátu konkrétní
důvod ze zdrojáku: router uvnitř používá `reply_always`, takže jeho vlastní handler
rozhoduje, jestli chybu hopu propaguje, nebo spolkne. Kdyby ji spolkl, vrátil by „úspěch"
a nedodal nic. Rozdíl zůstatku + vlastní `min_out` guard to chytí. Důvěra v `expected_return`
uvnitř routeru ne.

**Proč `reply_on_success` a ne `reply_always`.** Selhání swapu tak rovnou shodí tx
a stkd-SCRT se vrátí uživateli. Při `reply_always` bychom museli chybu v handleru ručně
vyzvednout a znovu vyhodit — víc kódu, víc způsobů, jak to udělat špatně.

---

## 5. Bezpečnost, konfigurace, admin

### 5.1 Allowlist na `info.sender` — povinný, obě větve

Bez něj ti kdokoli nasadí bezcenný SNIP-20 a zavolá `Receive { amount: 10_000_000, ... }`.
Jak by to skončilo přesně: `Redeem` bychom poslali na **skutečný** sSCRT, ten by selhal,
pokud kontrakt sSCRT nedrží — takže to není neomezená krádež. Ale pokud na kontraktu leží
zbloudilý sSCRT, útočník si ho tímhle vybere jako gas credit. Jednořádková absolutní
pojistka proti třídě, kterou jinak držíš jen invariantem I1.

Autorizace stojí **výhradně** na `info.sender`. `sender` a `from` z `Receive` jsou
informativní; grantee přichází z payloadu.

### 5.2 min_out / slippage

- **Povinný** parametr volání pro swapovou větev, **bez defaultu v kontraktu**. Kontrakt
  nemá jak vědět, co je rozumné, a tichý default je přesně to číslo, co se jednou stane
  špatným a nikdo si nevšimne.
- Posílá se routeru jako `expected_return` **a zároveň** se kontroluje v našem `reply`
  proti rozdílu zůstatku. Dvakrát schválně: první je pohodlí (levnější chyba), druhá nese
  bezpečnost, protože router je cizí a přepínatelný kontrakt.
- Pro sSCRT větev **zakázaný** (`Some` → chyba). Tiché ignorování parametru je horší.
- Důsledek: i kdyby admin přepnul `router` na škodlivý kontrakt, ztráta je shora omezená
  tím, co si vyžádal volající. Proto `min_out` patří do volání, ne do konfigurace.

### 5.3 Reentrance mezi `Receive` a `reply`

Mezi uložením `before` a jeho čtením běží cizí kód (router, pár, oba tokeny). Kdyby se
někdo dostal zpět do `Receive`, přepsal by `Pending.before`.

Reálné, ne teoretické: kdyby router doručoval výstup přes `Send` s `msg`, náš `Receive`
by se spustil uprostřed swapu. Ze zdrojáku vychází `create_send_msg` bez payloadu, tedy
nejspíš `Transfer` — ale „nejspíš" je málo, když je obrana takhle levná.

**Obrana: jednoslotový zámek.** `Receive` odmítne cokoli při obsazeném `Pending`;
`reply` uvolní. Není to fronta, je to zákaz vnoření — jedna tx = jeden nákup.
Zaseknout se nemůže: spadlá tx rollbackne i storage, zámek zmizí s ní.

### 5.4 Atomicita — „swap projde, grant ne"

Taková cesta neexistuje, a to není náhoda:

- `Redeem` a `Grant` v `reply` jsou obyčejné `add_message`, ne submessage → jejich chyba
  se propaguje nahoru.
- V celém kontraktu je **jediný** `reply` a je `on_success`. Nikde `reply_always`
  ani `reply_on_error`, tedy nikde místo, kde by šlo chybu spolknout.

Hlídat i v review, ne jen v testech: *žádný `reply_always` v tomhle kontraktu.*

### 5.5 Code hash pinning a drobnosti

Volání se šifruje proti code hashi — špatný hash není degradace, je to tvrdá chyba
(`gasVault.ts` to komentuje u `codeHashFor`). Adresa a hash proto cestují jako jedna
struktura `Contract`, nikdy zvlášť: migrace routeru mění obojí naráz.

Dál: `addr_validate` na `grantee`; `amount == 0` → chyba; `checked_sub` na
`after - before` (underflow = chyba, ne nula); SNIP-20 `padding` netřeba (délky jsou
beztak předvídatelné, citlivá je částka, a ta je šifrovaná).
`granterFor` ve frontendu **beze změny** — typ zprávy je pořád
`/secret.compute.v1beta1.MsgExecuteContract`, takže `AllowedMsgAllowance` omezení
fungují dál.

### 5.6 Konfigurace

**Neměnné (instantiate):** `gas_vault` — přesměrování vaultu je **jediná skutečná cesta
ke krádeži** (falešný vault peníze přijme a nic negrantne), zamrznuto. `sscrt` — druhá
polovina téhož vektoru, není důvod měnit. `viewing_key` — parametr, ne generovaný, protože
**není ověřené, že `BlockInfo` v secret-cosmwasm-std 1.1.11 má pole `random`** (chain
feature `random` inzerovaná je, ale to je něco jiného; viz O1). V README poznámka, že klíč
**není citlivý** — kdo ho zná, přečte zůstatek, který má být trvale nula.

**Admin smí měnit:** `router` (Shade se může přenasadit; škoda z podvrženého routeru je
omezená `min_out`, proto je bezpečné to povolit) · `routes` — allowlist a mapa cest jsou
**jedna struktura**, ne dvě, aby se nerozešly · `admin` (aby šel zahodit).

### 5.7 Má mít executor admina? Ano

- **Kdyby ne:** první změna adresy routeru nebo migrace poolu kontrakt zabije. To se
  u DEXu stane.
- **Riziko:** executor **nedrží peníze v klidu** (I1), na rozdíl od vaultu. Škoda ze zlého
  zásahu je omezená na to, co je zrovna v letu — jeden nákup jednoho uživatele — a u konfigurace
  navíc na `min_out`. Řádově menší expozice než u vaultu, kde admin vysaje společný zůstatek.
- **Migrate admin je jiná liga:** vymění kód celý, včetně zamrzlé `gas_vault` adresy.

Doporučení, dvojí posture:
1. **Config admin (v kontraktu): ano, trvale.** Levný, ohraničený, potřebný.
2. **Migrate admin (chainový): ano, ale dočasně.** Fáze 1 ho potřebuje kvůli povýšení
   na fázi 2. Po fázi 2 a době v provozu `secretd tx compute clear-contract-admin` —
   stejná rada jako v README vaultu, tady silnější, protože zamrzlá `gas_vault` adresa
   pak má skutečně cenu.

### 5.8 Zbloudilé prostředky — `SweepToVault`

I1 říká, že na konci volání drží executor nulu; neříká, že mu nikdo nemůže poslat
`Transfer` mimo volání. Takový zůstatek se v rozdílu vyruší (je v `before` i `after`),
takže nic nerozbije, ale zůstane ležet.

**`SweepToVault {}` bez oprávnění:** vykoupí sSCRT zůstatek a pošle nativní SCRT do vaultu
obyčejným bank sendem, ne jako `Grant`. Nikdo z toho nic nemá, takže není co zneužít;
vault sám dokumentuje, že kdo mu pošle SCRT bez nákupu, hýbe tím jen bezpečným směrem;
a nevyžaduje to privilegovaný klíč. Admin-only `Recover` zamítnut: dává adminovi pravomoc
sahat na tokeny, kterou jinak nemá, kvůli prachu.

---

## 6. Invarianty

| | |
| --- | --- |
| **I1** | Na konci každého volání drží executor nulu ve všech tokenech (sSCRT, stkd-SCRT, uscrt). Kontrolovat všechny tři po každém testu, ne jen ten, co zrovna teče. Výjimka: zůstatek ležící tam před voláním zůstane nezměněn (5.8). |
| **I2** | Neexistuje cesta, kde swap projde a grant ne. Strukturálně: jediný `reply`, `on_success`; `Redeem`+`Grant` obyčejné zprávy. Test: nechat vault selhat, ověřit, že vstupní token je zpátky u odesílatele. |
| **I3** | Gas vault se nemění. Používá se výhradně `Grant { grantee }` s `funds`. Test: po nákupu `Status.balance` i `Remaining { grantee }` vzrostly přesně o udělenou částku. |
| **I4** | sSCRT `Redeem` je 1:1. Přímá větev: grant == poslaná částka, do posledního uscrt. |
| **I5** | Swapová větev: grant == (sSCRT zůstatek po − před), přesně, a `>= min_out`. Nikdy `return_amount` z odpovědi routeru. |
| **I6** | Zbloudilý zůstatek nezkresluje rozdíl. Test: nasypat sSCRT předem, nakoupit, ověřit, že grant odpovídá jen tomu, co přinesl swap. |
| **I7** | Zámek se nezasekne. Test: nechat tx spadnout po nastavení `Pending`, další nákup musí projít. |

---

## 7. Testovací strategie

### Unit (`mock_dependencies`)

Vzor je hotový v `contracts/gas-vault/src/contract.rs` — `ChainQuerier`, který odpovídá
jako chain, a `decode_grant`, který zprávu dekóduje zpátky a kontroluje pole po poli.
Totéž tady, jen SNIP-20 `Balance` místo feegrantu.

Pokrytí: přesný tvar každé zprávy (dekódovat zpátky, netvrdit o řetězci) · allowlist na
obou větvích · zámek · `min_out` chybí/přebývá/nesplněn · aritmetika rozdílu (nenulový
`before`, `after < before`) · sSCRT větev nevyprodukuje **žádný** submessage · v kódu
není `reply_always` (grep-test nebo review checklist).

Co unit testy **nepokryjí**: `mock_dependencies` submessage nevykoná, jen vrátí `Response` —
takže celý nosný prvek návrhu je unit testem neověřitelný.

### LocalSecret — mock router jako první krok

Nosná otázka: **proběhne náš `reply` po submessage, který sám uvnitř používá `reply_always`?**
Nasadit kvůli tomu celý ShadeSwap je drahé a stejně by to nevyrobilo zajímavé případy selhání.

Napsat **mock router** (~100 řádků, jen pro testy), který (1) přijímá `Receive` +
`InvokeMsg::SwapTokensForExact` se stejným tvarem payloadu, (2) **sám dispatchne
`SubMsg::reply_always` na mock pár** — tím reprodukuje přesně tu strukturu, o kterou jde,
(3) na konci pošle `recipient` sSCRT `Transfer`.

S ním jde deterministicky otestovat, co s reálným routerem nejde:
reply doběhne přes cizí kontrakt, který sám používá reply (**hlavní test**) · mock doručí
míň, než slíbil → `min_out` guard shodí tx · mock doručí nulu a vrátí „úspěch" (spolknutá
chyba) → chytíme to · mock zavolá zpátky náš `Receive` uprostřed → zámek odmítne ·
vault odmítne `Grant` → revert včetně vstupu.

### Reálný ShadeSwap

Podle výsledku dotazu na factory (sekce 1):
- **Je na pulsar-3** → integrační test proti němu, malá částka.
- **Není** → tři možnosti v tomhle pořadí: (1) **doporučeno** zůstat u mock routeru pro
  strukturu a jít na secret-4 s prachovou částkou (0,1 SCRT) — argument je stejný jako
  v README vaultu pro první mainnetový nákup: tx je atomická, takže chain, který to neumí,
  peníze vrátí, cena zjištění je gas, ne částka; (2) nasadit ShadeSwap ze zdrojáku na
  LocalSecret (factory + pár + LP token + router a jejich instantiate tanec);
  (3) totéž na pulsar-3, jen pomalejší.

### Změřit hned, ne na konci — gas

Řetěz je hluboký: SNIP-20 `Send` → náš `Receive` → `Send` na router → vnitřní reply řetěz
routeru → swap na páru → `Transfer` → náš `reply` → `Redeem` → `Grant` ve vaultu →
a v něm feegrant query + `Revoke` + `Grant` přes Stargate. Dnešní `GAS_BUY = 400_000` na to
nestačí ani omylem. Pokud to narazí na strop gasu na tx, je to architektonické omezení pro
cokoli dalšího (víc hopů), ne detail k doladění na konci.

---

## 8. Frontend — rozsah

| soubor | co s ním |
| --- | --- |
| `src/lib/chains.ts` | Per-chain `swapAndGrantAddress`, `sscrt`, `stkdScrt`, `shadeRouter`, `sscrtStkdPair`, každý `{ address, codeHash }`. Přes `configuredValue()` s env overridy, jak to dělá `gasVaultAddress`. Žádná modulová konstanta (pravidlo z `CLAUDE.md`). |
| `src/lib/snip20.ts` (nový) | `send()`, zůstatek přes viewing key/permit, `keplr.getSecret20ViewingKey`, `keplr.suggestToken`. |
| `src/lib/swapQuote.ts` (nový) | `SwapSimulation { offer }` na pár → `return_amount` + fee → `min_out`. |
| `src/lib/gasVault.ts` | Přibude `buyGasCreditWithToken(...)` stavějící SNIP-20 `Send` s base64 payloadem. Nová konstanta `GAS_BUY_VIA_SWAP` — **změřená**. `buyGasCredit` a `codeHashFor` beze změny. |
| `src/components/BuyCreditModal.tsx` | Největší kus: výběr tokenu (SCRT / sSCRT / stkd-SCRT), zůstatek per token, živý kurz („≈ 4,87 SCRT creditu, min. 4,82 při 1 % slippage"), pole na slippage. |
| — viewing key flow | Nejméně předvídatelná část. Uživatel bez klíče na stkd-SCRT nevidí zůstatek; potřebuje `suggestToken` nebo ruční klíč, plus stav „klíč nemám, zůstatek neznám" — ne „zůstatek je nula". Přesně to rozlišení, které repo řeší i jinde (`RemainingResponse.amount: Option`). |
| `src/components/Dashboard.tsx` | Protáhnout novou submit cestu; po nákupu refresh vaultu i zůstatků. |
| `useFeePayer` / `granterFor` | **Beze změny.** |
| `.env.example`, `README.md` | Nové proměnné; sekce pod „Gas credits". |

**Odhad:** kontrakt ~400–600 řádků včetně testů, frontend ~500–700 řádků přes ~8 souborů.

**Default pro `min_out`:** `SwapSimulation { offer }` v reálné velikosti obchodu →
`return_amount` → `min_out = return_amount * (1 − slippage)`. Default slippage 1 %, pole
pro uživatele, plus tvrdá pojistka: implikuje-li simulace cenový dopad nad ~5 %, nabídku
neukázat a říct, že pool je na tuhle částku mělký.

**Past:** stkd-SCRT je staking derivát, kurz vůči SCRT **není 1:1** a v čase roste.
`min_out` musí vždy pocházet ze simulace, nikdy z předpokladu parity. Rezervy poolu jsem
odsud přečíst nemohl, takže konkrétní číslo musí vzniknout z prvního čtení chainu.

---

## 9. Pořadí prací

| # | co | závisí na |
| --- | --- | --- |
| 0 | Dohledat na chainu: pár sSCRT/stkd-SCRT + rezervy, code hash routeru, Shade na pulsar-3, sSCRT na pulsar-3. Zapsat do `chains.ts`. | síť |
| 1 | **Fáze 1**: kontrakt jen se sSCRT větví + unit testy. Nasadit na pulsar-3, ověřit řetěz proti živému vaultu (řeší i O6). Frontend: výběr tokenu se dvěma položkami, bez kurzu a slippage. | 0 (jen sSCRT) |
| 2 | Mock router + mock pár na LocalSecretu. **Ověřit, že reply proběhne** + všechny scénáře selhání ze sekce 7. | 1 |
| 3 | **Fáze 2**: swapová větev, `reply`, viewing key, zámek, routes/admin. Migrace fáze 1 na místě. | 2 |
| 4 | Integrace proti reálnému ShadeSwapu (pulsar-3, jinak prachový nákup na secret-4). Změřit gas. | 3, 0 |
| 5 | Frontend: kurz, slippage, viewing key flow, zůstatky. | 4 (kvůli změřenému gasu) |
| 6 | README kontraktu ve stylu `gas-vault/README.md` — co je ověřené a čím. secret-4 nasazení. | 5 |

Krok 2 je schválně **před** krokem 3: pokud reply přes cizí kontrakt neproběhne tak, jak
návrh předpokládá, celá fáze 2 se přepracovává, a je lepší to zjistit proti stránkovému
mocku než po napsání ostrého kontraktu.

---

## 10. Otevřené otázky

| | |
| --- | --- |
| **O1** | Má `BlockInfo` v secret-cosmwasm-std 1.1.11 pole `random`? Určuje, jestli si viewing key vygenerujeme, nebo bereme jako parametr. Návrh počítá s parametrem. |
| **O2** | Existuje ShadeSwap na pulsar-3? Určuje krok 4. |
| **O3** | Code hash routeru na secret-4 — jen jednozdrojový, nepotvrzený údaj. |
| **O4** | Adresa a rezervy páru sSCRT/stkd-SCRT. Bez nich nejde napsat konkrétní default pro slippage. |
| **O5** | Doručuje router výstup přes `Transfer` (bez callbacku), nebo `Send` s `msg`? Ze zdrojáku to vypadá na první; pokud druhé, spustí se náš `Receive` uprostřed swapu — zámek to zvládne, ale poznámka v návrhu se změní. |
| **O6** | Projde `CosmosMsg::Stargate` z vaultu, když je vault volaný jako vnořený kontrakt (executor → vault → Stargate)? Podpisová kontrola compute modulu je per-message a podepisujícím je vault, takže *by* měl projít. Neověřeno a **blokující** — patří do kroku 1, ne až do 4. |
| **O7** | Proběhne reply po submessage, který sám uvnitř používá `reply_always`? Nosný prvek návrhu. Krok 2. |
| **O8** | Je sSCRT `Redeem` opravdu striktně 1:1 bez poplatku na nasazené instanci? Očekávám ano, ale I4 to má tvrdit assertem, ne vírou. |
| **O9** | Spolkne router při selhání hopu chybu do zdánlivého úspěchu? Rozdíl zůstatku to dělá bezpředmětným, ale bylo by dobré to vědět. |
| **O10** | Kolik to stojí gasu a vejde se to do stropu na tx? Měřit co nejdřív. |
| **O11** | `SweepToVault` bez oprávnění, nebo admin-only `Recover`? Doporučuju první; je to volba, ne fakt. |

---

## 11. Ověření

Tenhle plán zatím nic nemění. Až se bude implementovat, ověřovat takto:

```bash
cd contracts/swap-and-grant && cargo test        # unit testy, vzor gas-vault
npm run lint && npm run typecheck                # frontend
npm run test:sdk                                 # regrese feegrant SDK
```

Devnet / testnet, v tomhle pořadí:
1. LocalSecret + mock router: reply proběhne, všech pět scénářů selhání ze sekce 7.
2. pulsar-3: fáze 1 end-to-end proti živému vaultu — grant se po tx přečte z chainu
   (`Remaining { grantee }`), ne jen „tx neselhala".
3. I1 po každém běhu: dotaz na všechny tři zůstatky executoru, všechny nula.
4. I3: `Status.balance` vaultu před/po, vzrostl přesně o udělenou částku.

