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

### Rozhodnuto uživatelem: **jen secret-4, pulsar-3 se vynechává**

ShadeSwap na pulsar-3 není, existuje jen na secret-4, a testnetová varianta se proto
ruší úplně — executor se na pulsar-3 nenasadí vůbec. Tři důsledky, rozvedené níž:

1. **Jedno nasazení, obě větve.** Odpadá důvod dělit to na dvě nasazené fáze. sSCRT
   a swapová větev půjdou na chain zároveň. To ruší i jedinou cenu rozhodnutí
   „jeden kontrakt" ze sekce 2: nepotřebujeme migrate admina kvůli povýšení z fáze 1
   na fázi 2, protože žádná fáze 1 samostatně nasazená nebude. Sekce 5.7 na to reaguje
   a migrate admina úplně škrtá.
2. **Fáze 1 přichází o levný důkaz.** Původně měl nákup za sSCRT proběhnout nejdřív
   na testnetu; teď je první reálné spuštění čehokoli z tohohle rovnou na secret-4
   za skutečné peníze. **Beru to jako tvoje rozhodnutí a stavím podle něj**, ale je
   správné to pojmenovat: riziko se přesouvá z testnetu na LocalSecret a na velikost
   první částky.
3. **LocalSecret tím nese obě nosné otázky, ne jednu.** Dřív měl odpovědět jen na O7
   (proběhne reply přes cizí kontrakt); teď na něm musí padnout i O6 (projde Stargate
   grant z vaultu volaného jako vnořený kontrakt), protože pulsar-3 už na to neodpoví
   zadarmo. Dobrá zpráva: `contracts/gas-vault` je v tomhle repu, takže na LocalSecret
   jde nasadit celá sestava — vault, executor, mock sSCRT, mock router — a odbavit
   celý řetěz lokálně, bez sítě a bez peněz. Detaily v sekci 7.

### Potvrzeno z reálné transakce (amino JSON od uživatele)

Dekódováním adres z podepsané stkd-SCRT → sSCRT swap transakce na secret-4:

- `contract` = `secret1k6u0cy4feepm6pehnz804zmwakuwdapm69tuc4` — **stkd-SCRT**, shodné
  s dokumentací. Třetí nezávislé potvrzení, tentokrát přímo z chainu.
- **Tvar interakce sedí na návrh.** Uživatel volá *token*, ne router — tedy
  `stkd.Send { recipient: router, msg: InvokeMsg::… }`. Náš executor se do toho vsouvá
  minimálně: `recipient` se změní z routeru na executor a payload z `SwapTokensForExact`
  na `BuyCredit`. Zbytek zůstává.
- **Co v ní není:** `msg` je šifrovaný, takže adresa routeru, adresa páru ani `min_out`
  z ní přečíst nejdou — na Secretu je to tak schválně. Zůstávají na `deploy.ts` níž.
- **`gas: 1270775` za samotný swap.** Viz níž; je to nejdůležitější číslo v celém dokumentu.

### Gas je teď hlavní riziko návrhu, ne poznámka pod čarou

1,27 M je gas *limit* té transakce, tedy horní odhad se zásobou, ne spotřeba — ale i tak
říká, že swapová noha sama se pohybuje v řádu milionu. Náš řetěz k ní přidává:
`Send` na executor → `Receive` → dva dotazy na sSCRT zůstatek → `reply` → `Redeem` →
`Grant` ve vaultu, a v něm feegrant query + `Revoke` + `Grant` přes Stargate.

Realistický rozpočet je tedy **2,5 M a víc na jednu transakci**, a to je poprvé číslo,
u kterého není samozřejmé, že se vejde do stropu gasu na tx. **Pokud se nevejde, padá
celý návrh na jeden podpis**, protože rozdělit to na dvě transakce znamená vrátit se
přesně k tomu problému, kvůli kterému executor vzniká.

Důsledky pro plán práce:
- Gas se měří na LocalSecretu **v kroku 4, hned jak swapová větev poprvé projde**,
  ne až u frontendu. Je to potenciální stopka, ne ladění.
- Změřit se musí strop chainu, ne jen naše spotřeba (`consensus_params.block.max_gas`
  a případný limit na tx) — to je jeden LCD dotaz, který spadne do kroku 6, ale pokud
  ho zvládneš dřív, ušetří to případné překvapení.
- Levnější varianta existuje a stojí za změření zvlášť: **první nákup pro danou adresu**
  je znatelně lacinější, protože vault u neznámého grantee přeskakuje feegrant query
  i `Revoke` (viz `held_by` v `gas-vault/src/contract.rs`). Rozdíl mezi prvním
  a opakovaným nákupem tedy patří do měření jako dvě čísla, ne jedno.

### Zbývající neznámé — řeší je deploy skript, ne můj odhad

Blokátor není volba chainu, ale to, že egress proxy nepouští **žádný** LCD host.
Adresy sSCRT a stkd-SCRT na secret-4 mám dvojitě potvrzené z dokumentace, ale
**adresa páru sSCRT/stkd-SCRT, jeho rezervy a code hash routeru přečíst nejdou.**

Řešení: nehádat je a nezapisovat je natvrdo z paměti, ale **nechat je přečíst deploy
skript při běhu**. `contracts/swap-and-grant/scripts/deploy.ts` si před instantiate
načte code hash routeru (`codeHashByContractAddress`), vyhledá pár přes factory
a dotáhne `GetPairInfo`; vypíše je a hlasitě selže, pokud něco nesedí. Precedens má
tenhle repo už v `contracts/gas-vault/scripts/deploy.ts`, který po nákupu čte grant
zpátky z chainu, protože „tx neselhala" není důkaz.

Tím se z „nemám přístup na chain" stává krok, který u sebe v terminálu spustíš ty,
a ne díra v návrhu.

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

**Cena, která odpadla.** Původně to mělo háček: fáze 2 mění kód, takže fáze 1 by musela
být nasazená s migrate adminem, aby šla povýšit na místě. Když se pulsar-3 vynechává
a obě větve jdou na chain jedním nasazením, tenhle háček mizí — a s ním hlavní argument
pro migrate admina (sekce 5.7). Rozhodnutí „jeden kontrakt" tím vychází čistě.

Fáze zůstávají jako **pořadí práce**, ne jako dvě nasazení: sSCRT větev se píše první,
protože je jednodušší polovina a nese celý sdílený ocas.

---

## 3. Entry pointy a zprávy

```
InstantiateMsg {
  gas_vault:   Contract { address, code_hash },      // adresa NEMĚNNÁ, hash měnitelný
  sscrt:       Contract { address, code_hash },      // adresa NEMĚNNÁ, hash měnitelný
  viewing_key: String,                               // NEMĚNNÉ
  admin:       Option<String>,                       // default = odesílatel
  router:      Option<Contract>,                     // admin; None je platný stav
  routes:      Vec<(Contract /*token*/, Vec<Hop>)>,  // admin; smí být prázdné
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

**`router: None` zůstává podporovaný stav, i když ho zatím nikde nenasadíme.** Není to
mrtvý kód pro budoucí pulsar-3, je to tvar, ve kterém se kontrakt testuje: na LocalSecretu
běží nejdřív sestava bez routeru (sSCRT větev samotná) a teprve pak s mock routerem.
Volání swapové větve bez nakonfigurovaného routeru musí skončit srozumitelnou chybou,
ne panikou na `unwrap()`.

`Routes {}` slouží zároveň frontendu jako zdroj pravdy o tom, co daný deployment umí —
lepší než druhá kopie seznamu v `chains.ts`, která by se rozešla.

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

**Neměnné (instantiate):** `gas_vault.address` — přesměrování vaultu je **jediná skutečná
cesta ke krádeži** (falešný vault peníze přijme a nic negrantne), zamrznuto.
`sscrt.address` — druhá polovina téhož vektoru. `viewing_key` — **parametr instantiate,
ne generovaný**, a teď z ověřeného důvodu, ne z nejistoty.

Ověřeno stažením crate: `BlockInfo` v secret-cosmwasm-std 1.1.11 pole
`pub random: Option<Binary>` **má** (`src/types.rs:95`) — ale je za cargo feature `random`,
jejíž zapnutí přidá do wasm export `requires_random` (`src/exports.rs:34`), který chain
při uploadu kontroluje proti svým inzerovaným schopnostem. Přesně ta třída rizika, před
kterou README vaultu varuje v sekci „If the upload is rejected".

Takže: dalo by se to, ale kupovali bychom si za novou upload-time podmínku úsporu jednoho
parametru — a `random` je navíc `Option`, takže bychom stejně museli psát fallback.
Nestojí to za to, protože ten klíč **není citlivý**: kdo ho zná, přečte si zůstatek,
který má být trvale nula. Do README to patří jako věta, ne jako varování.

**Admin smí měnit:** `router` (Shade se může přenasadit; škoda z podvrženého routeru je
omezená `min_out`, proto je bezpečné to povolit) · `routes` — allowlist a mapa cest jsou
**jedna struktura**, ne dvě, aby se nerozešly · `admin` (aby šel zahodit) · **code hashe
zamrzlých adres**, tedy `gas_vault.code_hash` a `sscrt.code_hash`, při neměnné adrese.

Ten poslední bod je nenápadný, ale nese hodně: gas vault je **migratelný** (jeho README to
zdůvodňuje) a migrace mu změní code hash. My ho pinujeme, protože volání se proti němu
šifruje — takže migrace vaultu by nám executor zabila. Rozdělením `Contract` na zamrzlou
adresu a měnitelný hash se to spraví bez migrate admina: přepsat hash u pevné adresy
nikam peníze přesměrovat nemůže, špatný hash jen způsobí, že volání selže.
Tohle je to, co dovoluje nasadit executor jako immutable.

### 5.7 Má mít executor admina? Config ano, migrate ne

- **Kdyby ne:** první změna adresy routeru nebo migrace poolu kontrakt zabije. To se
  u DEXu stane.
- **Riziko:** executor **nedrží peníze v klidu** (I1), na rozdíl od vaultu. Škoda ze zlého
  zásahu je omezená na to, co je zrovna v letu — jeden nákup jednoho uživatele — a u konfigurace
  navíc na `min_out`. Řádově menší expozice než u vaultu, kde admin vysaje společný zůstatek.
- **Migrate admin je jiná liga:** vymění kód celý, včetně zamrzlé `gas_vault` adresy.

Doporučení — **změnilo se** poté, co padl pulsar-3:

1. **Config admin (v kontraktu): ano, trvale.** Levný, ohraničený, potřebný.
2. **Migrate admin (chainový): ne. Nasadit rovnou immutable** (`--no-admin`).

Migrate admina jsem původně doporučoval; tři věci ho teď dohromady vyvracejí:

- **Nepotřebuje ho fázování.** Obě větve jdou na chain jedním nasazením, takže není
  co povyšovat na místě.
- **Executor nezávisí na žádném allow-listu.** Vault migratelný být musí, protože stojí
  na stargate query, kterou si chain vyhrazuje právo odebrat. Executor se ptá jen
  obyčejnou contract query na SNIP-20 a posílá jen `WasmMsg::Execute` — nic z toho není
  vyhrazené. Hlavní argument z README vaultu se sem nepřenáší.
- **Jediný reálný spouštěč migrace je vyřešený jinak.** Bylo by jím to, že se vault
  zmigruje a změní si code hash. To pokrývá měnitelný `gas_vault.code_hash` při zamrzlé
  adrese (5.6), což je mnohem užší pravomoc než výměna celého kódu.

Zbývá tím jediná ztráta: neopravitelná chyba v kódu executoru znamená nasadit nový
a přepsat adresu ve frontendu. To je přijatelné právě proto, že executor **nedrží peníze
v klidu** — nikdo o nic nepřijde, jen se přestane dát nakupovat. U vaultu by taková
ztráta byla nepřijatelná, u tohohle je to výměna dílu.

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

### LocalSecret — mock router, jediný předmainnetový test swapu

Nosná otázka: **proběhne náš `reply` po submessage, který sám uvnitř používá `reply_always`?**

Když se vynechává i pulsar-3, LocalSecret **je** testnet — jediné místo, kde cokoli
z tohohle poběží dřív, než na to na secret-4 pošleme reálné peníze. Odpovídajícím
způsobem se do něj investuje: mock není kulisa, je to náhrada za testnet.

Nasazuje se tam **celá sestava, ne jen executor**: `contracts/gas-vault` je v tomhle repu,
takže na LocalSecret jde postavit vault + executor + mock sSCRT (`snip20-reference-impl`)
+ mock router + mock pár a projet celý řetěz od uživatelova `Send` po vydaný fee grant.
Tím tam padne i **O6** — projde `CosmosMsg::Stargate` z vaultu, když je vault volaný jako
vnořený kontrakt — což měl původně zadarmo odbavit pulsar-3. To je blokující otázka
pro obě větve, takže se testuje **hned v prvním kole**, na sestavě bez routeru,
ještě než se píše swap.

Pořadí na LocalSecretu je proto:
1. vault + executor + mock sSCRT, **bez routeru** → sSCRT větev end-to-end, řeší O6, I4.
2. totéž + mock router + mock pár → swapová větev, řeší O7 a scénáře selhání níž.

Napsat **mock router** (~100 řádků, jen pro testy), který (1) přijímá `Receive` +
`InvokeMsg::SwapTokensForExact` se stejným tvarem payloadu, (2) **sám dispatchne
`SubMsg::reply_always` na mock pár** — tím reprodukuje přesně tu strukturu, o kterou jde,
(3) na konci pošle `recipient` sSCRT `Transfer`.

S ním jde deterministicky otestovat, co s reálným routerem nejde:
reply doběhne přes cizí kontrakt, který sám používá reply (**hlavní test**) · mock doručí
míň, než slíbil → `min_out` guard shodí tx · mock doručí nulu a vrátí „úspěch" (spolknutá
chyba) → chytíme to · mock zavolá zpátky náš `Receive` uprostřed → zámek odmítne ·
vault odmítne `Grant` → revert včetně vstupu.

### Reálný ShadeSwap — jen secret-4

Testnet odpadá, takže zbývají dvě cesty a doporučuju první:

1. **Mock router na LocalSecretu pro strukturu, pak secret-4 s prachovou částkou**
   (0,1 SCRT). Argument je stejný jako v README vaultu pro první mainnetový nákup:
   tx je atomická, takže chain, který to neumí, peníze vrátí — cena zjištění je gas,
   ne částka. Tady je ještě silnější, protože `min_out` ohraničuje i to, co může
   pokazit swap sám.
2. Nasadit **celý ShadeSwap ze zdrojáku na LocalSecret** (factory + pár + LP token +
   router a jejich instantiate tanec) a odbavit swap lokálně. Věrnější, ale je to den
   práce navíc a pořád to není důkaz o secret-4 — jiné adresy, jiné rezervy, jiná verze.
   Sáhnout po tom jen tehdy, když mock router odhalí, že se něco chová jinak, než návrh
   předpokládá.

### Změřit hned, ne na konci — gas

Podrobně v sekci 1 („Gas je teď hlavní riziko návrhu"). Zkráceně: reálná swapová
transakce má limit 1,27 M, náš řetěz na ni nabaluje `Receive`, dva dotazy na zůstatek,
`reply`, `Redeem` a vaultův `Grant` se Stargate revoke+grant. Dnešní `GAS_BUY = 400_000`
nestačí ani omylem.

Měřit se to musí **v tomto kroku**, jakmile swapová větev poprvé projede mock routerem,
a odděleně pro první a opakovaný nákup. Pokud se to nevejde do stropu na tx, není to
věc k doladění — je to nález, který shazuje myšlenku jednoho podpisu, a chce se o něm
dozvědět tady, ne po nasazení.

---

## 8. Frontend — rozsah

| soubor | co s ním |
| --- | --- |
| `src/lib/chains.ts` | Per-chain `swapAndGrantAddress`, `sscrt`, `stkdScrt`, `shadeRouter`, `sscrtStkdPair`, každý `{ address, codeHash }`. Přes `configuredValue()` s env overridy, jak to dělá `gasVaultAddress`. Žádná modulová konstanta (pravidlo z `CLAUDE.md`). |
| `src/lib/snip20.ts` (nový) | `send()`, zůstatek přes viewing key/permit, `keplr.getSecret20ViewingKey`, `keplr.suggestToken`. |
| `src/lib/swapQuote.ts` (nový) | `SwapSimulation { offer }` na pár → `return_amount` + fee → `min_out`. |
| `src/lib/gasVault.ts` | Přibude `buyGasCreditWithToken(...)` stavějící SNIP-20 `Send` s base64 payloadem. Nová konstanta `GAS_BUY_VIA_SWAP` — **změřená**. `buyGasCredit` a `codeHashFor` beze změny. |
| `src/components/BuyCreditModal.tsx` | Největší kus: výběr tokenu, zůstatek per token, živý kurz („≈ 4,87 SCRT creditu, min. 4,82 při 1 % slippage"), pole na slippage. **Nabídka tokenů je per-chain a řídí se konfigurací, ne podmínkou na `chainId`**: pulsar-3 nemá `swapAndGrantAddress`, takže se tam chová přesně jako dnes — jen SCRT, žádný výběr tokenu. Sedí to na existující vzor, kde prázdná `gasVaultAddress` schová tlačítko „Buy gas credit"; žádné `if (chainId === ...)` nikde nepřibude. |
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

Všechno až po krok 5 běží **bez sítě a bez peněz**, u mě. Krok 6 pouštíš ty v terminálu.

| # | co | kde |
| --- | --- | --- |
| 1 | sSCRT větev + unit testy (vzor `gas-vault`). Wasm build přes pinovaný optimizer. | lokálně |
| 2 | LocalSecret, sestava **bez routeru**: vault + executor + mock sSCRT. sSCRT větev end-to-end. **Řeší O6** — Stargate grant z vnořeného vaultu. | LocalSecret |
| 3 | Swapová větev: `reply`, viewing key, zámek, `routes`/admin. Unit testy. | lokálně |
| 4 | Mock router + mock pár. **Řeší O7** — reply přes cizí kontrakt, který sám používá `reply_always` — a všechny scénáře selhání ze sekce 7. Změřit gas celého řetězu. | LocalSecret |
| 5 | Frontend celý: `chains.ts`, `snip20.ts`, `swapQuote.ts`, `gasVault.ts`, modal, kurz, slippage, viewing key flow. `deploy.ts`, který si router hash a pár načte z chainu sám. README. | lokálně |
| 6 | **Nasazení na secret-4** deploy skriptem + prachový nákup (0,1 SCRT) za stkd-SCRT. Doplnit adresy do `chains.ts`. | tvůj terminál |

Kroky 2 a 4 jsou schválně **před** tím, než se cokoli dostane na mainnet: pokud
Stargate z vnořeného vaultu nebo reply přes cizí kontrakt nefungují tak, jak návrh
předpokládá, je to přepis návrhu, a je mnohem lepší to zjistit proti mocku než
za peníze. Krok 2 je navíc před krokem 3 proto, že O6 shazuje **obě** větve, ne jen swap —
nemá smysl psát swap, dokud není jistý společný ocas.

Krok 6 je jediné místo, kde se utrácí, a je až na konci schválně: do té chvíle je
rozhodnutí poslat na secret-4 reálné peníze pořád otevřené a podložené vším předchozím.

---

## 10. Otevřené otázky

| | |
| --- | --- |
| ~~O1~~ | **Uzavřeno:** `BlockInfo.random: Option<Binary>` v 1.1.11 existuje (`src/types.rs:95`), ale za feature `random`, která přidá do wasm `requires_random` a tím novou upload-time podmínku. Nebereme; viewing key zůstává parametrem. Zdůvodnění v 5.6. |
| ~~O2~~ | **Uzavřeno:** ShadeSwap na pulsar-3 není, jen na secret-4. Pulsar-3 se vynechává úplně. Důsledky v sekci 1. |
| ~~O3~~ | **Přesunuto z odhadu do běhu:** code hash routeru si načte `deploy.ts` z chainu (`codeHashByContractAddress`) místo toho, aby byl zapsaný natvrdo. |
| ~~O4~~ | **Přesunuto z odhadu do běhu:** adresu páru a rezervy si `deploy.ts` dotáhne z factory a `GetPairInfo`. Konkrétní default pro slippage se dopočítá až z nich, v kroku 6. |
| **O5** | Doručuje router výstup přes `Transfer` (bez callbacku), nebo `Send` s `msg`? Ze zdrojáku to vypadá na první; pokud druhé, spustí se náš `Receive` uprostřed swapu — zámek to zvládne, ale poznámka v návrhu se změní. |
| **O6** | Projde `CosmosMsg::Stargate` z vaultu, když je vault volaný jako vnořený kontrakt (executor → vault → Stargate)? Podpisová kontrola compute modulu je per-message a podepisujícím je vault, takže *by* měl projít. **Blokující pro obě větve** — padá v kroku 2 na LocalSecretu, ještě než se píše swap. |
| **O7** | Proběhne reply po submessage, který sám uvnitř používá `reply_always`? Nosný prvek návrhu. Krok 4, mock router. |
| **O8** | Je sSCRT `Redeem` opravdu striktně 1:1 bez poplatku na nasazené instanci? Očekávám ano, ale I4 to má tvrdit assertem, ne vírou. |
| **O9** | Spolkne router při selhání hopu chybu do zdánlivého úspěchu? Rozdíl zůstatku to dělá bezpředmětným, ale bylo by dobré to vědět. |
| **O10** | **Nejdůležitější otevřená otázka.** Vejde se celý řetěz do stropu gasu na tx? Reálná swapová tx má limit 1,27 M a my na ni nabalujeme vaultův Stargate revoke+grant; rozpočet 2,5 M+. Záporná odpověď shazuje návrh na jeden podpis. Měří se v kroku 4, zvlášť pro první a opakovaný nákup. |
| **O11** | `SweepToVault` bez oprávnění, nebo admin-only `Recover`? Doporučuju první; je to volba, ne fakt. |

---

## 11. Ověření

Tenhle plán zatím nic nemění. Až se bude implementovat, ověřovat takto:

```bash
cd contracts/swap-and-grant && cargo test        # unit testy, vzor gas-vault
npm run lint && npm run typecheck                # frontend
npm run test:sdk                                 # regrese feegrant SDK
```

LocalSecret, v tomhle pořadí — bez sítě, bez peněz:

1. **Sestava bez routeru** (vault + executor + mock sSCRT): sSCRT větev end-to-end.
   Grant se po tx **přečte zpátky z chainu** (`Remaining { grantee }`), ne že „tx
   neselhala" — to je precedens z `gas-vault/scripts/deploy.ts`. Řeší O6 a I4.
2. **Plus mock router a mock pár**: swapová větev, O7, a všech pět scénářů selhání
   ze sekce 7 (podhodnocené doručení, spolknutá chyba, vnořené volání, selhání vaultu).
3. **I1 po každém běhu**: dotaz na všechny tři zůstatky executoru, všechny nula.
4. **I3 po každém nákupu**: `Status.balance` vaultu před/po, vzrostl přesně o udělenou
   částku — a `Remaining { grantee }` o tutéž.
5. **Gas** celého řetězu změřený a zapsaný do `GAS_BUY_VIA_SWAP`, ne odhadnutý.

Teprve pak secret-4 (krok 6, tvůj terminál): `deploy.ts` si dotáhne router hash i pár
z chainu, nasadí immutable, a prachový nákup 0,1 SCRT za stkd-SCRT ověří celý řetěz
proti reálnému ShadeSwapu. Tx je atomická, takže neúspěch stojí gas, ne částku.

