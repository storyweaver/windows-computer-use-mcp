# Windows Computer Use MCP

<p align="center">
  <a href="../../README.md">English</a> | <a href="README_zh-CN.md">中文</a> | <a href="README_ja.md">日本語</a> | **Français** | <a href="README_de.md">Deutsch</a>
</p>

**Le seul serveur MCP d'automatisation du bureau Windows construit sur l'architecture officielle Chicago MCP d'Anthropic.**

Les memes 24 outils. Le meme modele de securite a 3 niveaux. La meme optimisation de tokens. Seule la couche native a ete remplacee pour Windows.

Tous les autres MCP d'automatisation de bureau construisent leurs schemas d'outils, leur modele de securite et leur logique de dispatch a partir de zero. Ce projet reutilise directement **plus de 6 300 lignes** du code de production d'Anthropic -- le meme code qui alimente le controle de bureau macOS integre a Claude Code -- et ne remplace que la couche native (capture d'ecran, saisie, gestion des fenetres) par des equivalents Windows.

---

## Pourquoi cette architecture est differente

La plupart des MCP d'automatisation de bureau fournissent au modele quelques outils primitifs (capture d'ecran, clic, saisie) en esperant que tout se passe bien. **Chicago MCP** -- l'architecture interne d'Anthropic pour le controle de bureau -- adopte une approche fondamentalement differente : elle traite l'automatisation du bureau comme une **session avec etat et gouvernance**, dotee d'une securite multicouche, d'un budget de tokens et d'une execution par lots.

Nous avons porte cette architecture sur Windows. Voici ce que cela implique concretement :

### Comparaison d'architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│              Autres serveurs MCP                                    │
│                                                                     │
│   screenshot() ──→ le modele regarde ──→ click(x,y) ──→ repeter    │
│                                                                     │
│   Pas de securite. Pas de lots. Pas de budget tokens. Pas d'etat.   │
│   Le modele doit analyser visuellement TOUT, a chaque fois.         │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│              Ce projet (architecture Chicago MCP)                    │
│                                                                     │
│   ┌──── Couche Session ───────────────────────────────────────┐     │
│   │  request_access → permissions 3 niveaux (read/click/full) │     │
│   │  Autorisations par app, blocklist de touches, verrou app  │     │
│   └───────────────────────────────────────────────────────────┘     │
│   ┌──── Couche Efficacite ────────────────────────────────────┐     │
│   │  computer_batch : N actions → 1 appel API                 │     │
│   │  API structurees : cursor_position, read_clipboard,       │     │
│   │    open_application — pas de capture d'ecran necessaire    │     │
│   │  targetImageSize : recherche binaire pour ≤1568 tokens    │     │
│   └───────────────────────────────────────────────────────────┘     │
│   ┌──── Couche Vision (uniquement si necessaire) ─────────────┐     │
│   │  screenshot → le modele voit l'UI → click/type/scroll     │     │
│   │  zoom → recadrage haute resolution pour texte fin         │     │
│   └───────────────────────────────────────────────────────────┘     │
│   ┌──── Couche Native (Windows) ──────────────────────────────┐     │
│   │  node-screenshots (DXGI) │ robotjs (SendInput)            │     │
│   │  koffi + Win32 API       │ sharp (JPEG/resize)            │     │
│   └───────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

### Comparaison directe des fonctionnalites

| Fonctionnalite | **Ce projet** | CursorTouch<br/>Windows-MCP<br/>(5k stars) | MCPControl<br/>(306 stars) | domdomegg<br/>computer-use-mcp<br/>(176 stars) | sbroenne<br/>mcp-windows<br/>(24 stars) |
|---|:---:|:---:|:---:|:---:|:---:|
| **Execution par lots** (N actions, 1 appel API) | **Oui** | Non | Non | Non | Non |
| **Optimisation du budget tokens** (redimensionnement par recherche binaire ≤1568 tokens) | **Oui** | Non | Non | Non | Non |
| **Permissions par app a 3 niveaux** (read / click / full) | **Oui** | Non | Non | Non | Non |
| **Verrou d'app au premier plan** (bloque si la mauvaise app est active) | **Oui** | Non | Non | Non | Non |
| **Blocage des touches dangereuses** (Alt+F4, Win+L, Ctrl+Alt+Del) | **Oui** | Non | Non | Non | Non |
| **API structurees** (obtenir des infos sans capture d'ecran) | **Oui** | Partiel | Partiel | Non | Oui |
| **Zoom** (recadrage haute resolution pour les details fins) | **Oui** | Non | Non | Non | Non |
| **Multi-ecran** (changement par nom de moniteur) | **Oui** | Non | Non | Non | Non |
| **Meme schema d'outils que Claude Code integre** | **Oui** | Non | Non | Proche | Non |
| **Code Anthropic amont reutilise** | **6 300+ lignes** | 0 | 0 | 0 | 0 |
| Nombre d'outils | 24 | 19 | 12 | 6 | 10 |
| Langage | TypeScript | Python | TypeScript | TypeScript | C# |

### Pourquoi l'execution par lots est importante

Sans `computer_batch`, une sequence clic-saisie-entree necessite **5 allers-retours API** (3 a 8 secondes chacun). Avec :

```javascript
// 5 allers-retours → 2. 60% de latence et de tokens en moins.
computer_batch([
  { action: "left_click", coordinate: [100, 200] },
  { action: "type", text: "hello world" },
  { action: "key", text: "Return" },
  { action: "screenshot" }
])
```

Aucun autre serveur MCP Windows ne prend cela en charge.

### Pourquoi "utiliser les API quand c'est possible" compte

Les autres MCP forcent le modele a **capturer l'ecran et analyser visuellement chaque element**. Chicago MCP : si l'information est disponible via une API, inutile de gaspiller des tokens de vision.

| Tache | Autres MCP | Ce projet |
|---|---|---|
| Quelle app est au premier plan ? | Capture d'ecran → le modele lit la barre de titre | `getFrontmostApp()` → donnees structurees |
| Ou est le curseur ? | Capture d'ecran → le modele devine | `cursor_position` → coordonnees exactes `{x, y}` |
| Lire le presse-papiers | Ctrl+V dans Notepad → capture d'ecran → lecture | `read_clipboard` → chaine de texte |
| Ouvrir une application | Capture d'ecran → trouver l'icone → cliquer | `open_application("Excel")` → appel API |
| Changer de moniteur | Capture d'ecran → mauvais moniteur → reessayer | `switch_display("Dell U2720Q")` |

Chaque capture d'ecran evitee economise environ **1 500 tokens de vision** et **3 a 5 secondes**.

---

## Demarrage rapide

### Prerequis

- **Node.js** 18+
- **Windows 10/11**
- Visual Studio Build Tools (pour robotjs)

### Installation

```bash
git clone https://github.com/storyweaver/windows-computer-use-mcp.git
cd windows-computer-use-mcp
npm install
npm run build
```

### Configuration dans Claude Code

Ajoutez ceci au fichier `.mcp.json` de votre projet :

```json
{
  "mcpServers": {
    "windows-computer-use": {
      "command": "node",
      "args": ["C:/path/to/windows-computer-use-mcp/dist/index.js"]
    }
  }
}
```

Redemarrez Claude Code. Vous verrez 24 nouveaux outils prefixes par `mcp__windows-computer-use__`.

### Tests

```bash
npm test          # 70 tests (unitaires + integration)
npm run test:unit # Tests unitaires uniquement
```

---

## Structure du projet

```
src/
├── upstream/              # 6 300+ lignes issues de @ant/computer-use-mcp (1 ligne modifiee)
│   ├── toolCalls.ts       # 3 649 lignes : securite + dispatch des outils
│   ├── tools.ts           # 24 definitions de schemas d'outils
│   ├── mcpServer.ts       # Fabrique du serveur MCP + liaison de session
│   ├── types.ts           # Systeme de types complet
│   ├── executor.ts        # Interface ComputerExecutor (reconstruite)
│   ├── keyBlocklist.ts    # Interception des touches dangereuses (branche win32 integree)
│   ├── pixelCompare.ts    # Detection de stagnation par pixels 9×9
│   ├── imageResize.ts     # Algorithme de budget tokens
│   └── ...                # deniedApps, sentinelApps, subGates
├── native/                # Couche native Windows (~400 lignes)
│   ├── screen.ts          # node-screenshots + sharp (capture DXGI)
│   ├── input.ts           # robotjs (souris/clavier SendInput)
│   ├── window.ts          # koffi + Win32 API (gestion des fenetres)
│   └── clipboard.ts       # PowerShell Get/Set-Clipboard
├── executor-windows.ts    # Implementation de ComputerExecutor
├── host-adapter.ts        # Assemblage du HostAdapter
├── logger.ts              # Journalisation dans un fichier
└── index.ts               # Point d'entree du serveur MCP stdio
```

## Pile technique

Chaque bibliotheque est l'equivalent Windows de ce que Chicago MCP utilise sur macOS :

| Module | macOS (Chicago MCP) | Windows (ce projet) | Role |
|---|---|---|---|
| Capture d'ecran | SCContentFilter | **node-screenshots** (DXGI) | Capture d'ecran |
| Saisie | enigo (Rust) | **robotjs** (SendInput) | Souris et clavier |
| Gestion des fenetres | Swift + NSWorkspace | **koffi** + Win32 API | Controle des fenetres |
| Traitement d'image | Sharp | **Sharp** | Compression JPEG + redimensionnement |
| Framework MCP | @modelcontextprotocol/sdk | **@modelcontextprotocol/sdk** | Protocole MCP |

## Les 24 outils

| Categorie | Outils |
|---|---|
| **Session** | `request_access`, `list_granted_applications` |
| **Vision** | `screenshot`, `zoom` |
| **Clic souris** | `left_click`, `double_click`, `triple_click`, `right_click`, `middle_click` |
| **Controle souris** | `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `cursor_position` |
| **Defilement** | `scroll` |
| **Clavier** | `type`, `key`, `hold_key` |
| **Presse-papiers** | `read_clipboard`, `write_clipboard` |
| **App/Affichage** | `open_application`, `switch_display` |
| **Lots + Attente** | `computer_batch`, `wait` |

## Modele de securite

Permissions par application a trois niveaux -- le seul serveur MCP a proposer cela :

| Niveau | Capture d'ecran | Clic | Saisie/Collage |
|---|:---:|:---:|:---:|
| **read** (navigateurs, trading) | Oui | Non | Non |
| **click** (terminaux, IDE) | Oui | Clic gauche | Non |
| **full** (tout le reste) | Oui | Oui | Oui |

En complement : blocage des touches dangereuses, verrou d'application au premier plan, autorisations limitees a la session.

## Journaux

```
%LOCALAPPDATA%\windows-computer-use-mcp\logs\mcp-YYYY-MM-DD.log
```

## Limitations connues

- **Saisie de texte CJK** : utilisez `write_clipboard` + `key("ctrl+v")` pour le texte non-ASCII
- **Decouverte d'applications** : ne renvoie actuellement que les applications en cours d'execution (analyse du registre prevue)
- **Validation de pixels** : desactivee (sharp asynchrone incompatible avec l'interface synchrone)
- **hideBeforeAction** : desactive (la minimisation interrompt les processus enfants WebView2)

## Licence

MIT

## Remerciements

Construit sur `@ant/computer-use-mcp` (Chicago MCP) d'Anthropic, extrait de Claude Code v2.1.88. Le code amont dans `src/upstream/` appartient a Anthropic ; la couche native Windows est originale.
