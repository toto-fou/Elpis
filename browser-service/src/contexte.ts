// SPDX-License-Identifier: MIT
/** browser-service/src/contexte.ts — état du service passé à chaque famille de routes (sessions, refs de localisateur, verrous de démarrage, Chromium partagé, proxy du relais) et formes d'une session. */
import type { Browser, BrowserContext, Locator, Page } from 'playwright';

import type { CibleEnregistree, EvenementEnregistre } from './recorder_util.ts';
import type { EntreeReseau, EvenementSelect, ParamsCible } from './result_util.ts';
import type { Verrou } from './session_lock.ts';
import type { OngletFerme } from './tab_util.ts';

/** Console line of a page (errors and warnings), with the document (no fragment) that emitted it. */
export interface LigneConsole {
    line: string;
    doc: string;
}

/** Network journal of a session; `formes`: forms of a secret being typed, purged from what the page returns. */
export type JournalReseau = EntreeReseau[] & { formes?: string[] | null };

/** Download started by a page of the session; `fini` settles once the file is saved (or failed). */
export interface Telechargement {
    debut: number;
    nom: string;
    fini: Promise<{ file: string; path?: string; size?: number; error?: string }>;
}

/** Native dialog seen by the session. */
export interface DialogueVu {
    type: string;
    message: string;
    action: string;
    input_text: string;
    seq: number;
    policy: 'armed' | 'default';
}

/** Policy armed by pw_dialog for the next dialogs. */
export interface PolitiqueDialogue {
    action: string;
    input_text?: string;
    sticky?: boolean;
    remaining: number;
}

/** Dialogs of a session: armed policy, last ones seen; `formes` as in JournalReseau. */
export interface EtatDialogues {
    pending: PolitiqueDialogue | null;
    last: DialogueVu | null;
    count: number;
    history: DialogueVu[];
    formes?: string[] | null;
}

/** Response simulated for the requests of a session (pw_mock). */
export interface Simulation {
    id: string;
    url_pattern: string;
    method?: string;
    status: number;
    content_type?: string;
    body?: string;
    headers?: Record<string, string>;
    delay_ms?: number;
    times: number;
    _re?: RegExp | null;
    _used?: number;
    _exhausted?: boolean;
    /** `url_pattern` est une expression régulière (`_re`), pas une sous-chaîne. */
    is_regex: boolean;
    created_at: number;
}

/** Geste noté par l'enregistreur (recordEvent) : cible, valeur ou option choisie, touche, choix d'une sélection, chemin des cadres, script évalué. */
export interface GesteEnregistre extends EvenementEnregistre, EvenementSelect {
    key?: string;
    kind?: string;
    option?: string;
    option_locator?: CibleEnregistree;
    frames?: string[];
    script?: string;
    in_all_frames?: boolean;
}

/** Recorder of a session (pw_recorder). */
export interface Enregistreur {
    recording: boolean;
    start_ts: number;
    stop_ts?: number;
    events: (GesteEnregistre & { ts: number })[];
    variables: Map<string, string>;
}

/** Browser session of an owner: its context, active tab and journals. */
export interface Session {
    context: BrowserContext;
    page: Page;
    owner: string;
    group: string;
    isolated: boolean;
    consoleLogs: LigneConsole[];
    networkLog: JournalReseau;
    downloads: Telechargement[];
    tabs: Page[];
    mousePos: { x: number; y: number };
    createdAt: number;
    lastActivity: number;
    traceActive: boolean;
    _lock: Verrou;
    dialogState: EtatDialogues;
    /** TLS policy of the vault secret the session was opened for (never reused afterwards). */
    tls: string | null;
    _frozenPings?: number;
    screenshotCounter?: number;
    ongletsOuverts?: Page[];
    ongletsFermes?: OngletFerme[];
    reveilsOnglet?: (() => void)[];
    _connexionEnCours?: boolean;
    _mocksSuspendus?: boolean;
    _mocks?: Simulation[];
    _mockHandlerRegistered?: boolean;
    _recorder?: Enregistreur;
    /** Elements already returned by inspect, per step (since_step). */
    _inspectSnapshots?: Record<number, Set<string>>;
}

/** Locator handed out by pw_find, replayed by pw_act through its `ref` (5 min). */
export interface RefLocator {
    sid: string;
    locator: Locator;
    params: ParamsCible;
    frame: { name?: string; url?: string } | null;
    expires_at: number;
}

/** State of the service, passed explicitly to helpers and route families. */
export interface ServiceContext {
    readonly sessions: Map<string, Session>;
    readonly locatorRefs: Map<string, RefLocator>;
    readonly ownerStartLocks: Map<string, Verrou>;
    /** Proxy of every browser context: the local filtering relay. */
    readonly proxy: { server: string; bypass: string };
    /** Chromium shared by the sessions, and its launch in progress. */
    navigateur: Browser | null;
    lancement: Promise<Browser> | null;
    /** Cleanup timers, stopped at shutdown. */
    readonly minuteries: ReturnType<typeof setInterval>[];
}

/** Fresh context of a service whose relay listens on `port`. */
export function creerContexte(port: number): ServiceContext {
    return {
        sessions: new Map(),
        locatorRefs: new Map(),
        ownerStartLocks: new Map(),
        proxy: { server: `http://127.0.0.1:${port}`, bypass: '<-loopback>' },
        navigateur: null,
        lancement: null,
        minuteries: [],
    };
}

declare module 'express' {
    interface Request {
        /** Session of the call (getSession). */
        session?: Session;
        sessionId?: string;
        /** Arrival time of the call. */
        recuA?: number;
    }
}

declare module 'playwright-core' {
    interface Page {
        /** Journaux console et réseau attachés (attachPageLoggers). */
        __pwLoggersAttached?: boolean;
        /** Popups et fermetures suivies (suivreOnglets). */
        __elpisOngletsSuivis?: boolean;
        /** Fermé par le service lui-même, non annoncé comme fermé par la page. */
        __elpisFermeParService?: boolean;
    }
}
