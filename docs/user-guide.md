# Elpis — User Guide

# Getting started

## Welcome
<!-- aide: bienvenue -->

Elpis is an assistant that does more than answer: it acts, in a workspace of your own. This help explains each feature, with a short animated clip when a gesture is easier to show than to describe.

### The essentials

1. Sign in with the username and password given to you by your administrator.
2. Write your request in the composer, then press `Enter`.
3. Read the answer, then carry on the conversation or click **Nouveau chat** (New chat) to change subject.

The application runs in a browser. There is nothing to install on your computer.

### What the application can do

- **Converse with a language model**, served by your organization or, if the administrator allows it, by an external provider. See [The chat](#the-chat) and [Models and providers](#models-and-providers).
- **Act with tools**: read and write files, run commands, drive a browser, draw charts, keep a memory. See [When the assistant acts](#when-the-assistant-acts) and [Tools and the MCP panel](#tools-and-the-mcp-panel).
- **Work in your sandbox**: an isolated space of your own, with your files, a code editor and a terminal. See [The sandbox and the code editor](#the-sandbox-and-the-code-editor).
- **Delegate** part of the work to subagents. See [Subagents](#subagents).
- **Schedule** tasks that run without you. See [Routines](#routines).
- **Answer from your documents**, citing its sources. See [Your documents (RAG)](#your-documents-rag).

Some of these features may be missing from your installation: the administrator is the one who turns them on.

> **Local by default.** The model, your files and your conversations stay on your organization's server. Nothing leaves it, except through what has been explicitly opened: an external model provider, a web browsing tool, or network access granted to your sandbox by the administrator.

### Using this help

To open the help, click your name at the bottom of the sidebar, then **Aide** (Help). You can also type `/help` in the composer.

- **The sections are on the left.** One section is displayed at a time. At the bottom of each section, two links lead to the previous and the next one.
- **The help opens on the screen you are on.** From a conversation, it shows [The chat](#the-chat); from the routines, [Routines](#routines); with the editor open, [The sandbox and the code editor](#the-sandbox-and-the-code-editor).
- **The search field**, **Rechercher dans l'aide** (Search the help), keeps only the sections that contain your word. `Enter` opens the first one.
- **The clips** loop, without sound. A click on a clip pauses it; another click restarts it. If animations are reduced (the **Animations** row of Paramètres (Settings) › **Apparence** (Appearance) › **Thème** (Theme), or your computer when it is set to **Système** (System)), they wait for your click to start.
- Each section has a **Getting the most out of it** part: the shortcuts and options that are rarely found on your own.
- `Esc` closes the help. You find the screen as you left it.

### Signing in

[Entering your username and password, then landing on the home screen](media/aide/connexion.webm)

1. Enter your **Identifiant** (Username) and your **Mot de passe** (Password).
2. Click **Se connecter** (Sign in), or press `Enter`.
3. The home screen appears: "Bonjour" (Hello), followed by your name, above the composer.

What to know:

- **Accounts are created by an administrator**, or at your first sign-in if your organization connected its own accounts (see below). There is no open registration.
- The eye icon, in the password field, shows what you type.
- **Wrong username or password**: check what you typed, capital letters in particular. After several failures, the application asks you to wait a few minutes.
- **New password**: if the administrator assigned you a password, the application asks you to choose another one the first time you sign in. Enter it twice, then click **Appliquer et continuer** (Apply and continue). The rules (length, capital letters, digits, special characters) are set by the administrator.
- **Nobody can read your password**, not even an administrator. They can only assign you a new one.
- **Session length.** By default, a session lasts 24 hours: after that, the application asks for your username and password again. The administrator can adjust this length, and can close your sessions remotely.

### Signing in with your organization's account

If your administrator connected the accounts of your organization, you sign in with them and not with a password created in Elpis.

- **Single sign-on**: the login page offers a **Se connecter avec** (Sign in with) button named after your organization's service. Click it, sign in there as usual, and you come back to Elpis signed in.
- **Local account**: if the page shows the single sign-on buttons, **Compte local** (Local account) opens the username and password form of an account created in Elpis.
- **Your password is managed by your organization.** In Paramètres › **Profil**, the message **Votre mot de passe est géré par votre organisation** (Your password is managed by your organization) replaces the password change. Change or reset it where your organization does it.
- **First sign-in.** If you belong to the authorized group, your account is created automatically; its name is derived from your username.
- **You already had an Elpis account.** At your first sign-in with your organization's account, the login page asks for your Elpis password **one last time**. Enter it and click **Relier mon compte** (Link my account). After five wrong passwords the request is cancelled: ask your administrator to prepare it again. From then on you sign in with your organization's account only, and the personal API tokens and application access you had created are removed: create them again if you use them. If your administrator verified your identity themselves, the question is not asked.
- **If you are refused.** The message says **Votre compte n'est pas autorisé à utiliser Elpis** (Your account is not allowed to use Elpis) when you do not belong to the authorized group, when your account is deactivated or when its name is already taken; **Une vérification en deux étapes est exigée** (A two-step check is required) when your organization asks for one; **Le service de connexion de votre organisation ne répond pas** (Your organization's sign-in service does not respond) when its service is down, in which case try again later. A short **Référence** (Reference) may appear under the message: pass it on to your administrator.
- **Your role and groups** may be set by your organization from your groups there: they then follow them at each sign-in.
- **If you leave the group or your organization**, your account is deactivated at the next check: your sessions end and your tools stop working. Your conversations and files are kept.

### The account menu

[The account menu opens with a click on your name, at the bottom of the sidebar](media/aide/compte-menu.webm)

Click your name, at the bottom of the sidebar. The menu shows your name and your role, then offers:

- **Aide** (Help): this help.
- **Informations** (Information): the name and version of the application, and the engine that serves the model. Useful when you report a problem.
- **Se déconnecter** (Sign out): closes your session on this browser.

To change your photo or your password, open Paramètres (the gear icon, to the right of your name) › **Profil** (Profile). See [Settings](#settings).

### Getting the most out of it

- `/help` opens the help without leaving the keyboard. `/settings` opens the settings, `/usage` your consumption.
- Start with [A tour of the interface](#a-tour-of-the-interface) if you are new to the application, then [The chat](#the-chat).
- A specific question? Type a word in **Rechercher dans l'aide** rather than browsing the sections.
- If something does not go as expected, see [Troubleshooting](#troubleshooting) and [Frequently asked questions](#frequently-asked-questions).

## A tour of the interface
<!-- aide: interface -->

The application fits on a single screen: a sidebar on the left to navigate, the conversation in the center, the composer at the bottom. Other views open next to the conversation or in its place, and `Esc` takes you back one step.

[Opening a conversation, a panel, the Plus menu, collapsing the sidebar, then returning to a new chat](media/aide/tour-interface.webm)

### The essentials

1. On the left, click **Nouveau chat** (New chat) to start from a blank page, or a conversation in the list to reopen it.
2. In the center, read the conversation. Its title is at the top left.
3. At the bottom, write in the composer and press `Enter`.
4. To open a work tool (**MCP**, **Sandbox**, **Routines**, **Plus** (More)), click its name in the sidebar.

On a new chat, the composer is in the middle of the page, under "Bonjour" (Hello) and your name. It moves down to the bottom of the screen with your first message.

### The sidebar

From top to bottom:

- **The application name** and, to its right, the **Réduire le panneau** (Collapse the panel) button (double chevron).
- **Nouveau chat**: opens an empty conversation.
- **MCP**: opens on the right the panel of the tools the assistant can use. See [Tools and the MCP panel](#tools-and-the-mcp-panel).
- **Sandbox**: opens on the right your file space, with the code editor and the terminal. See [The sandbox and the code editor](#the-sandbox-and-the-code-editor).
- **Routines**: your scheduled tasks. See [Routines](#routines).
- **Plus**: a submenu to **RAG**, **Bibliothèque** (Library, your generated images), **Studio** and **Agents**.
- **Conversations**: your conversations, from the most recent to the oldest. The magnifying glass searches for a conversation; the neighboring icon lets you tick several. See [Conversations](#conversations).
- **At the bottom**: your name (the account menu), the bell for [Notifications](#notifications), the gear icon for [Settings](#settings). A shield is added if you are an administrator or a moderator.

A colored dot to the right of **MCP** or **Sandbox** shows that the panel is open. A dot to the right of a conversation shows that an answer is in progress there.

The **MCP** and **Sandbox** entries can be switched off in Paramètres (Settings) › **Fonctionnalités** (Features) › **Modules**. An entry that is missing from the **Plus** menu has not been opened for your account: ask your administrator.

### The conversation

- **The title**, at the top left, is proposed by the assistant after your first message. Double-click it to change it.
- **The three-dot button**, at the top right, opens the **Conversation** menu: **Renommer…** (Rename), **Rechercher** (Search), **Exporter** (Export), **Archiver** (Archive), **Supprimer** (Delete).
- **Your messages** are in a frame; the assistant's answers follow, without a frame.
- **Under each answer**, a discreet line gives the model, the duration and the speed. The actions (copy, regenerate) appear on hover. See [The chat](#the-chat).

### The composer

From left to right, under the text area:

- **+** (**Plus d'actions**, More actions): attach a file, see the shares you received, insert a skill, a prompt or a template, turn on plan mode, compact the conversation.
- **The microphone**, if dictation is available and turned on.
- **Status chips**, when they have something to say: **Mode plan** (Plan mode), **Tâches** (Tasks) with their progress, the share of the model's working memory that the conversation takes up.
- **The model name**: a click opens the list of models and the settings. See [Models and providers](#models-and-providers).
- **The send button.** During an answer, it becomes a red button that stops it.

### Panels and pages

- **To the right of the conversation**: **MCP** and **Sandbox** open a panel. The conversation stays visible and narrows. A second click on the sidebar entry, or the panel's cross, closes it.
- **In place of the conversation**: **Routines** and the pages of the **Plus** menu take the center of the screen. `Esc` takes you back to the chat; the **Routines** page also has a back arrow, at the top left.
- **On top of everything**: **Paramètres** and the help open in a window. `Esc` or the cross closes it.

Opening a page does not close your conversation: you find it as it was when you come back.

### Getting the most out of it

- **Gain space.** **Réduire le panneau** folds the sidebar into a column of icons: new chat, search, MCP, Sandbox, Routines, Plus, account, notifications, settings. **Ouvrir le panneau** (Open the panel) unfolds it.
- `Ctrl+Shift+O` opens a new chat from any page, as long as no window is open.
- `Esc` closes what is on top first: a menu, then a window, then a panel, then the open page.
- **Hover over the icons**: each one shows its name, and its shortcut when it has one.
- **Everything can also be done from the keyboard.** `Tab` moves from one element to the next; in a menu, `↑` and `↓` choose, `Enter` confirms.
- **On a narrow screen**, the sidebar hides by itself. The button at the top left of the conversation brings it back on top.
- **Change the look of the screen** in Paramètres › **Apparence** (Appearance): light or dark theme, skin. The density of the thread and what is displayed under the answers are set in Paramètres › **Chat** › **Affichage** (Display). See [Appearance](#appearance).
- The full list of keys is in [Keyboard shortcuts](#keyboard-shortcuts).

# Everyday use

## The chat
<!-- aide: chat -->

The chat is the main screen: you write a request, the assistant answers, and the conversation keeps the thread. This section covers the composer and everything you can do with a message or an answer.

[Writing a message, sending it, and watching the answer being written](media/aide/chat-envoyer.webm)

### The essentials

1. Click in the composer and write your request.
2. Press `Enter`, or click the send button on the right of the bar.
3. The answer is written as it goes. The conversation gets a title, at the top left.
4. Write the follow-up: the assistant takes into account everything that precedes it in the conversation.

`Shift+Enter` starts a new line without sending. To change subject, click **Nouveau chat** (New chat): one conversation per subject gives better answers.

### While the assistant answers

- **An indicator** says what is happening under the assistant's name: **En attente…** (Waiting) when other requests go before yours, **Connexion aux outils…** (Connecting to tools), **Réflexion…** (Reasoning), or the name of the tool in progress.
- **The composer** shows the elapsed time, the writing speed and the share taken by the conversation.
- **You can already write the follow-up.** The text area stays active: `Enter` starts a new line in it; send once the answer is finished.
- **Nothing is lost if you reload the page**: the answer keeps being written on the server and the display catches up.
- **If the connection drops**, the application retries by itself, twice, and says so: `Reconnexion (1/2)...` (Reconnecting).

### Stopping an answer, then continuing it

[Stopping the answer in progress, then resuming it with Continuer](media/aide/chat-arreter.webm)

1. During the answer, the send button becomes a red button. Click it to stop.
2. The text already written stays in place. Below it, a box says **Réponse interrompue** (Answer interrupted).
3. Click **Continuer** (Continue): the assistant completes the same answer, where it stopped. It does not start over.

What to know:

- The same box appears when an answer is cut because it was too long. Cut during reasoning, it says **Réflexion interrompue** (Reasoning interrupted): **Continuer** then makes the model conclude from the reasoning already written.
- After you stop during reasoning, before the first word of the answer, there is nothing to continue: **Continuer** is not offered. Use **Régénérer la réponse** (Regenerate the answer).
- If an answer fails, a line **Interrompue** (Interrupted) gives the cause (connection lost, timeout, engine busy…) and offers **Reprendre** (Resume) or **Réessayer** (Try again). **Copier le détail** (Copy the details) copies the technical message, useful to your administrator.
- When the cause is **contexte saturé** (context full), the conversation has become too long for the model: the button offered is **Nouveau chat**. See [The conversation context](#the-conversation-context).

### Answering now

[Cutting the reasoning short with Répondre maintenant to get the answer right away](media/aide/chat-repondre-maintenant.webm)

Some models reason before answering. If the reasoning lasts too long for a simple question:

1. While **Réflexion…** is displayed, click **Répondre maintenant** (Answer now), on the right.
2. The assistant stops reasoning and writes its answer from what it has already thought.

The button exists only during reasoning. It disappears as soon as the answer begins.

### Viewing the reasoning

[Unfolding the assistant's reasoning, then folding it back](media/aide/chat-reflexion.webm)

When the model has reasoned, a **Réflexion** block precedes the answer, with the time spent.

1. Click **Réflexion** to read the reasoning.
2. Click again to fold it.

You can also open it while it is being written; it folds when the answer is finished. The reasoning is not saved with the conversation: when you reopen it later, you find the answers, not the reasoning.

### Actions on an answer

[Copying an answer, then regenerating it](media/aide/chat-actions-message.webm)

Move the pointer over an answer: its actions appear at the bottom right.

- **Copier la réponse** (Copy the answer): copies the text. The icon turns into a check mark for a moment.
- **Détails** (Details): the timeline of the answer (tools called, model, durations). `Esc` closes it.
- **Régénérer la réponse**: erases the answer and asks for a new one to the same question.
- **Lire à voix haute** (Read aloud): present if voice playback is available.

### Correcting a message and resending it

[Editing your last message and resending it to get a new answer](media/aide/chat-editer.webm)

1. Move the pointer over one of your messages, then click the pencil (**Éditer et renvoyer**, Edit and resend).
2. Correct the text.
3. Click **Envoyer** (Send), or press `Ctrl+Enter`. `Esc` cancels.

The conversation restarts from that message: everything that followed it is replaced by the new answer. If you edit the very first message, the application asks for confirmation (**Modifier et régénérer**, Edit and regenerate). The files attached to the original message stay attached.

Next to the pencil, the bookmark (**Sauvegarder**, Save) saves your message as a reusable prompt. See [Prompts](#prompts).

### Attaching a file

[Attaching a file from your computer with the + button](media/aide/chat-fichiers.webm)

1. Click **+**, at the left under the text area, then **Joindre un fichier** (Attach a file).
2. Choose one or more files. Each one appears as a thumbnail above your text.
3. Write your request and send. To remove a file, hover over its thumbnail and click the cross.

You can also **drag files** from your computer and drop them on the conversation.

| Type | Limit | What the assistant receives |
|---|---|---|
| Text, code | 5 MB | The content, inserted in the message |
| Image | 15 MB | The image, if the model can read images |
| Network capture (`.pcap`, `.pcapng`, `.cap`) | — | Refused |

Ten files at most per message. A file that is too large is refused with a message, without blocking the others. Files are read as text: for a PDF or an office document, go through [The sandbox and the code editor](#the-sandbox-and-the-code-editor) or [Your documents (RAG)](#your-documents-rag) instead.

### Mentioning a sandbox file with @

[Typing @ to choose a sandbox file and attach it to the message](media/aide/chat-mention.webm)

1. Type `@` in the composer: the **Insérer un fichier** (Insert a file) list shows the files of your sandbox.
2. Keep typing to filter: `@plan`, `@src/`. The search covers the whole path, ignoring case.
3. Choose with `↑` and `↓`, confirm with `Enter`, or click the file. `Esc` closes the list.
4. The file appears as a thumbnail, like an attachment. Its content goes with the message.

The files you mentioned recently come first, under **Récents** (Recent). You can mention several files in the same message; they count toward the limit of ten.

### The / commands

[Typing / to open the commands, filter them, then choose one](media/aide/chat-commandes.webm)

1. Type `/` at the very start of the composer: the **Commandes** (Commands) menu opens. In the middle of a sentence, after a space, `/` also opens the menu: a chosen skill is pinned and your text stays in place.
2. Type the first letters to filter.
3. Choose with `↑` and `↓`, confirm with `Tab` or `Enter`, or click. `Esc` closes the menu without erasing what you typed.

| Command | Effect |
|---|---|
| `/agents` | Turns subagents on or off (`on`, `off`), or opens their page (`open`) |
| `/compact` | Summarizes the beginning of the conversation to free up space |
| `/help` | Opens this help |
| `/image` | Generates an image: `/image 16:9 x2 description` |
| `/jobs` | Lists background tasks (`/jobs all` for all conversations, `/jobs stop` to stop one) |
| `/memory` | Opens the long-term memory |
| `/plan` | Turns plan mode on or off (`/plan on`, `/plan off`) |
| `/prompt` | Inserts a saved or received prompt |
| `/rag` | Your document collections: `use`, `off`, `search`, `add`, `new`, `status`, `open` |
| `/routine` | Creates a routine with the assistant: `/routine` followed by your goal |
| `/secret` | Secrets of the conversation: `/secret`, `attach`, `detach` |
| `/settings` | Opens the settings, on a specific tab if you name it |
| `/skills` | Browses your skills and pins one to the next message |
| `/template` | Inserts a prompt template, after you fill in its variables |
| `/usage` | Opens the tracking of your consumption |

The menu shows only the commands available to you: `/image`, `/rag`, `/secret` and `/agents` depend on what the administrator has opened. A grayed-out command cannot be used at this moment: `/compact` needs a conversation that has already started, and several commands wait for the answer in progress to finish.

For details: [Subagents](#subagents), [The conversation context](#the-conversation-context), [When the assistant acts](#when-the-assistant-acts), [Memory](#memory), [Prompts](#prompts), [Your documents (RAG)](#your-documents-rag), [Routines](#routines), [Secrets and Git accounts](#secrets-and-git-accounts), [Skills](#skills).

### The line under an answer

Under each finished answer, a discreet line sums up what it cost. A token is a piece of a word: it is the unit in which the model counts text.

- **The model** that answered.
- **The duration** of the answer.
- **↓** the speed at which the model reads the conversation and **↑** the speed at which it writes, in tokens per second.
- **The brain**, followed by a number and `tk`: the tokens spent on reasoning.
- **cache N %**: the share of the conversation that the model already had in memory, and so read without effort.
- **The last number**: the space taken by the conversation, out of the total space available to the model.

Leave the pointer on the line: a tooltip details the input (already in memory, new) and the output (reasoning, answer).

### Dictating and having answers read to you

If your administrator has installed the voice engine, Paramètres (Settings) › **Chat** › **Voix** (Voice) offers:

| Setting | Effect |
|---|---|
| **Dictée** (Dictation) | A microphone button is added to the composer |
| **Réponse vocale** (Voice answer) | Answers are read aloud while they are written |
| **Lire entre les outils** (Read between tools) | Also reads what the assistant announces before each tool call |

**Dictating.** Click the microphone and speak normally. The text is written sentence after sentence, at each pause. It stays editable, and nothing is sent for you: you read it over, then you send. `Esc` or another click on the microphone stops the dictation, without touching what is already written.

**Listening.** **Lire à voix haute**, under each finished answer, reads that answer even if **Réponse vocale** is unchecked. A second click, or `Esc`, stops the playback. Starting to dictate also cuts the voice.

On a long task, the assistant announces its steps between two tools ("Je lance les tests…", I'm running the tests). **Lire entre les outils** reads them: useful when you are looking elsewhere, tiresome when you are waiting for the answer.

> Browsers allow the microphone only on a secure connection (HTTPS). If **Dictée** is grayed out, ask your administrator.

### Getting the most out of it

- **Prepare the follow-up during the answer.** Write your next message without waiting, then send it with `Enter` when the answer is finished.
- **Correct rather than repeat.** A badly asked question is better fixed with **Éditer et renvoyer** than with a second message: the conversation stays short and the assistant is not influenced by its first answer.
- **Regenerate to compare.** **Régénérer la réponse** gives another wording. Change the model first if you want a second opinion. See [Models and providers](#models-and-providers).
- **Cut a useless reasoning short** with **Répondre maintenant**, rather than stopping and restarting.
- **The + menu leads to the same functions as the commands**, with their name next to them: **Skills** (`/skills`), **Prompts** (`/prompt`), **Gabarits** (Templates, `/template`), **Mode plan** (`/plan`), **Compacter** (Compact, `/compact`).
- **A command accepts specifics.** `/settings chat` opens the **Chat** tab of the settings directly; type a space after the command to see the possible values.
- **No command by that name?** The menu switches to your skills: type `/` followed by the start of a skill name to pin it. And a message that starts with `/` without matching anything is simply sent to the assistant.
- **`@` followed by a piece of a path** is faster than searching the list: `@docs/` keeps only that folder.
- **Keep your good questions.** The bookmark on a message saves it; `/prompt` brings it back in any conversation.
- **Set what is displayed** (reasoning, measurements under the answers, thread density) in Paramètres › **Chat** › **Affichage**: see [Appearance](#appearance).
- **Give your instructions once and for all** in Paramètres › **Chat** › **Conversation**, **Prompt système** (System prompt) field: the assistant follows them in all your conversations.
- **Get back to the bottom in one click.** If you scrolled up the thread, the **Aller en bas** (Go to bottom) button takes you back to the last message.

### How it works

At each message, the assistant rereads the whole conversation: this is what lets it follow the thread, and it is why a very long conversation ends up slowing down, then filling up. See [The conversation context](#the-conversation-context); for what the thread shows when it uses tools, [When the assistant acts](#when-the-assistant-acts).

## When the assistant acts
<!-- aide: outils -->

A tool is an action that the assistant can ask the application to perform: read a file, run a command, search a documentation. With tools, it no longer just answers: it acts, then reports back. The thread shows what it does while it does it, and keeps a trace of it.

[The assistant chains two tools, then answers](media/aide/chat-outils.webm)

### The essentials

1. Turn on the tools useful to the conversation: see [Tools and the MCP panel](#tools-and-the-mcp-panel).
2. Send your request, as usual.
3. Follow the work line, under the assistant's name. It names the tool in progress and the step, for example "lire_page · étape 2/200" (read_page, step 2/200).
4. Read the answer. The work stays folded on one line above it, for example "La page existe, je la lis. · 2 outils" (The page exists, I'm reading it. 2 tools).

### Seeing what the assistant did

[Unfolding the work and opening a tool's detail](media/aide/chat-outils-detail.webm)

1. Click the work line. It unfolds: you read the sentences the assistant wrote between two actions, and one group per series of calls ("1 outil", "2 outils").
2. Click a group, then the name of the tool.
3. A card opens. **Paramètres** (Parameters) shows what the assistant asked for, **Résultat** (Result) what the tool replied. The cross closes it.

What to know:

- A failed call carries a red sign. Its card gives the error in place of the result.
- When the assistant wrote nothing between its actions, the line is titled "Travail de l'assistant" (The assistant's work).
- When you hover over an answer, the **Détails** (Details) button opens the timeline of the turn: tools, model, durations.
- Depending on the tools used, the answer also carries the live output of commands (the **Terminal en direct** (Live terminal) setting, in Paramètres (Settings) › **Chat** › **Conversation**; when off, the output stays readable in the tool's detail), the **Fichiers modifiés** (Modified files) list (lines added and removed, diff on click, **Télécharger** (Download)) or the browser's captures. See [The sandbox and the code editor](#the-sandbox-and-the-code-editor).
- The measurement line under the answer (model, duration, speed, context) is described in [The chat](#the-chat).

### Choosing how the work is presented

The **Déroulé** (Unfolding) setting, in Paramètres › **Chat** › **Affichage** (Display), changes the way a turn with tools is displayed: **Classique** (Classic, the default), **En bloc** (As a block), **Chronologie** (Timeline) or **Journal** (Log). See [Appearance](#appearance).

### The assistant's task list

[The Tâches chip opens the list kept by the assistant](media/aide/chat-liste-de-taches.webm)

For work in several steps, the assistant keeps its own task list. A **Tâches 1/4** chip then appears in the composer: one task done out of four.

1. Click the chip. The **Tâches de la session** (Session tasks) list opens; finished tasks are crossed out.
2. Click elsewhere, or the cross, to close it.

On hover, the chip shows the task in progress. It belongs to the conversation, comes back after a page reload, and disappears when everything is done.

### Answering a questionnaire

[Answering the assistant's two questions and sending](media/aide/chat-questionnaire.webm)

When it lacks some details, the assistant can ask several questions at once. The questionnaire opens in the composer, at the end of its answer.

1. Read the question ("Question 1 sur 2", Question 1 of 2) and click an option. With the note "Plusieurs choix possibles." (Several choices possible), you can tick more than one.
2. To add a detail, or for an answer that is not offered, write in the **Autre réponse, ou une précision…** (Other answer, or a detail) field. Your text is added to the ticked options.
3. Click **Suivant** (Next). **Retour** (Back) returns to the previous question.
4. On the last question, click **Envoyer les réponses** (Send the answers). They go in a single message and the assistant carries on.

What to know:

- From the keyboard: the digits `1` to `9` tick the option with the same number while the field is empty, `Enter` confirms, `Esc` closes.
- **Répondre librement** (Answer freely) closes the questionnaire without losing your answers. A chip, for example **Reprendre le questionnaire · 1 sur 2** (Resume the questionnaire), reopens it.
- Answering a single question is enough to send.
- The questionnaire stays available in plan mode. It does not exist in a routine or for a subagent.

### Asking for a plan before acting

[Turning on plan mode and receiving a plan](media/aide/chat-mode-plan.webm)

Plan mode has a piece of work prepared without touching anything. The assistant can read and search, but its writing tools are removed until its answer.

1. Click **+** in the composer, then **Mode plan** (Plan mode). Or type `/plan`.
2. The **Mode plan** chip appears in the composer.
3. Send your request. The assistant returns a plan: what it found, what it would change, in what order, and what can go wrong.
4. The mode turns itself off. The message "Plan rendu — mode plan terminé, outils rétablis." (Plan delivered — plan mode finished, tools restored) confirms it: your next message runs with all the tools.

What to know:

- To give it up, click the chip's cross or type `/plan off`. `/plan on` turns it on without the risk of toggling it off.
- The mode cannot be changed while an answer is being written.
- On a blank chat, it is first armed: "Mode plan armé — la conversation démarrera sans outils d'écriture." (Plan mode armed — the conversation will start without writing tools).
- In plan mode, the assistant does not delegate to a subagent and creates no image, routine or agent.

### Background tasks

[Opening the background tasks and stopping the one that is running](media/aide/chat-taches-de-fond.webm)

A long command (a test suite, a development server) can run as a background task in your sandbox, your isolated workspace. The assistant starts it, hands control back to you, and resumes when it ends.

1. Spot the **1 ici** (1 here) chip in the composer: a task is running for this conversation. Click it, or type `/jobs`.
2. The **Tâches de fond** (Background tasks) pane lists each task: its name, its state ("en cours" running, "arrêté" stopped), its duration, and what will wake the assistant ("fin du programme" end of the program, "texte « … »" text, "port 8000").
3. **Journal** (Log) opens the task's log in the editor. **Arrêter** (Stop) stops it. **Tout arrêter** (Stop all) stops all those in the list.

What to know:

- While it waits for a task, the assistant ends its answer with "En attente de « tests » · 0 min 02 s" (Waiting for "tests"). When the task ends, it resumes by itself and continues the same answer.
- If the task fails, a message "« tests » s'est arrêté : code 1" ("tests" stopped: code 1) offers **Aller au message** (Go to the message).
- A task that you stop does not wake the assistant.
- **Toutes les conversations** (All conversations) shows the tasks of your whole account, with a link to their conversation.
- **Ne pas me réveiller dans cette conversation** (Do not wake me in this conversation): the assistant is no longer restarted, the result is attached to your next message. The general setting is in Paramètres › **Chat** › **Conversation**: **Me réveiller quand une tâche de fond se termine** (Wake me when a background task ends).
- The counter "1 / 3" reminds you of the number of tasks allowed per conversation. The administrator sets this limit.
- Deleting a conversation stops its background tasks; the confirmation reminds you of it.

### Generating an image

[Opening Images mode, describing the image and generating it](media/aide/chat-images.webm)

Image generation appears only if the administrator has connected an image engine and your account is entitled to it.

1. In the composer, type `/image` then `Enter`, or press `Alt+I`. The bar switches to **Images** mode.
2. Set the format (**Carré** Square, **16:9**…), the size and the number of images if needed.
3. Describe the image, then click **Générer** (Generate).
4. A box holds the place of the image ("Génération · 12 s", Generating), then the image arrives in the thread.

In the Images mode bar, **Portrait / paysage** (Portrait / landscape) flips the format, **Enrichir** (Enrich) has the chat model rewrite your description before sending, and **Options avancées** (Advanced options) gives, depending on the engine, **Dimensions libres** (Free dimensions), **Graine** (Seed), **Étapes** (Steps) and **À éviter** (To avoid). The cross on the **Images** chip, or `Esc` on an empty field, leaves the mode.

**Bibliothèque** (Library), in the same bar or through **Plus** › **Bibliothèque**, gathers your images: **Toutes** (All) or **Cette conversation** (This conversation); on hover, **Télécharger** or **Supprimer** (Delete).

What to know:

- During computation, the box shows "En file · 2e" (Queued, 2nd) or "Génération · 12 s / ≈30 s" (≈ means estimated duration). Its square button cancels the request.
- Under the image: the model, the format, the size, the duration, and the seed when the engine provides it. **Copier** (Copy) copies the description. **Variantes** (Variants) relaunches the same request without erasing the images. **Régénérer les images** (Regenerate the images) replaces them.
- On hovering over an image: **Modifier** (Edit), **Télécharger**, **Supprimer**. A click opens the viewer; `←` and `→` move from one image to another.
- **Modifier** takes the image as the reference of the next request. You can also attach an image.
- A deletion can be undone for 5 seconds.
- The assistant can create an image itself during an answer if **Par le modèle** (By the model) is on in Paramètres › **Fonctionnalités** (Features) › **Images**. Your format, size and number preferences are also set there.
- Only your most recent images are kept; the administrator sets the number. A removed image shows "Expirée" (Expired).

### Charts

[A chart in the answer, switched from bars to a line](media/aide/chat-graphique.webm)

With the **Graphiques** (Charts) category turned on for the conversation, the assistant draws a chart from the figures you give it, or that it found. The chart is displayed in the answer.

1. Ask for a chart by giving the values, for example "Trace les ventes : juillet 120, août 98, septembre 143" (Draw sales: July 120, August 98, September 143).
2. On a bar chart, change its shape with **Barres** (Bars), **Courbe** (Line) or **Aire** (Area).
3. **Tableau** (Table) shows the data, **PNG** downloads the image, **Agrandir** (Enlarge) opens it full size (`Esc` to return).

The assistant chooses among about thirty types: bars, lines, pies, funnel, Gantt chart, indicators, tables.

### Getting the most out of it

- For delicate work, ask for a plan first with `/plan`, read it over, then answer "vas-y" (go ahead): that message runs with all the tools.
- `/image 16:9 x2 un phare au soleil couchant` (a lighthouse at sunset) generates two images directly, without opening Images mode. The format can also be written `carré`, `portrait` or `paysage`.
- `/jobs all` lists the background tasks of the whole account. `/jobs stop all` stops those of the conversation, `/jobs stop` followed by an identifier stops one.
- To see each step without unfolding anything, switch the **Déroulé** to **Chronologie** or **Journal**.
- When an answer was slow to come, **Détails** shows where the time went.
- If a long piece of work stops on "Budget de tours atteint" (Turn budget reached), click **Reprendre** (Resume) in the banner; for next time, raise **Tours d'outils** (Tool turns) (model menu › **Paramètres de génération…**, Generation settings). The same button follows other stops, such as "Budget de temps atteint" (Time budget reached).
- Work that requires a lot of reading can be handed to a subagent: your conversation receives only its report. See [Subagents](#subagents).

### How it works

A turn is everything the assistant does between your message and its final answer:

1. The application sends the model your message and the list of active tools.
2. The model asks for a tool. The application runs it, in your sandbox for files and commands, and sends the result back.
3. The model starts again as long as something is missing, then writes its answer.

Each round trip is a step. This is what makes "read this file, change it, run the tests, fix the errors" possible in a single request. The "étape 2/200" counter gives the current step and the limit of the turn, 200 by default.

A few tools cannot be ticked: the task list goes with any active tool, the questionnaire is offered without turning anything on, and delegation is added when subagents are turned on.

## The conversation context
<!-- aide: contexte -->

At each message, the assistant rereads the whole conversation. It can read only a limited amount of it: its context window. A gauge tells you where you stand, and compaction frees up space when the window fills.

[The gauge is red: Compacter summarizes the older history](media/aide/chat-contexte.webm)

### The essentials

1. Look at the gauge in the composer, next to the **+** button. "29,8 k/32,8 k" reads: 29,800 tokens used out of a window of 32,800. A token is a piece of a word, the unit in which the model counts text.
2. When it turns red, the **Contexte presque plein** (Context almost full) banner appears above the composer.
3. Click **Compacter** (Compact). The thread shows "Compaction en cours…" (Compaction in progress) and a progress bar.
4. At the end, the line "Conversation compressée" (Conversation compressed) confirms it. Carry on writing normally.

### Reading the gauge

- It appears after the first answer of the conversation, and comes back when you reopen it.
- Its color follows the filling: green, then the accent color from 65%, amber from 75%, red from 90% (**Jetons** (Tokens) form; the other forms turn amber, with a warning sign, at 80%).
- The same measurement appears under each answer: it is the context at the time of that answer.
- While an answer is being written, it becomes for example "42 + 26 / 32,8 k": what was sent, plus what the assistant has already written, reasoning included.
- On hover, it gives the exact figures and the percentage.
- Its form (tokens, block, percentage or ring) is chosen in Paramètres (Settings) › **Chat** › **Affichage** (Display), **Contexte** (Context) setting: see [Appearance](#appearance).
- The assistant's reasoning also counts in the window. Its display is set in [Appearance](#appearance), its level in [Models and providers](#models-and-providers).

### Compacting the conversation

Compaction has the model summarize the older exchanges. The summary takes their place in what is sent to it; the latest exchanges stay word for word. Your thread does not change: you can still reread everything.

Three ways to start it:

- the **Compacter** button of the **Contexte presque plein** banner, which appears at 90%;
- the `/compact` command, at any time;
- the **+** button of the composer, then **Compacter**.

What happens next:

- The line "Conversation compressée · ≈ 327 jetons" (Conversation compressed, about 327 tokens) gives the size of the history once summarized, and the time. **Voir le résumé** (View the summary) unfolds it.
- The banner disappears. So does the gauge, until the next answer: the old measurement is no longer valid.
- A counter above the composer, for example "1/12", shows the number of compactions already done and the maximum for the conversation.

What to know:

- Compaction needs a conversation that has already started, and no answer in progress. Otherwise **Compacter** is grayed out.
- On a conversation of a few exchanges, it does not apply: there is nothing to summarize.
- The banner also offers **Nouveau chat** (New chat). For a new subject, starting from an empty conversation is often simpler.

### Letting the application compact by itself

By default, nothing is compacted without you. To automate it, open Paramètres › **Avancé** (Advanced) › **Compaction** (the **Avancé** group unfolds with a click):

- **Compaction automatique** (Automatic compaction): the assistant summarizes the older turns when the threshold is reached.
- **Seuil** (Threshold): **Auto** (when the model's window is full), **Pourcentage** (Percentage; a share of the window, from 30 to 95%) or **Jetons** (a number of context tokens).
- **Compactions max** (Max compactions): **Auto** (ceiling set by the administrator), **Nombre** (Number; per conversation) or **Illimité** (Unlimited).

Once the ceiling is reached, the oldest turns are removed from the context instead of being summarized. The note "Compression max atteinte" (Maximum compression reached) shows it above the composer. The `/compact` command stays available in all cases.

### Getting the most out of it

- Compact before starting a big piece of work rather than in the middle of it: type `/compact` as soon as the gauge turns amber.
- After a compaction, open **Voir le résumé**. If an important point is missing, say it again in your next message.
- Switch conversations when you switch subjects: a less full window leaves more room for files and tool results.
- For a search that requires reading a lot, turn on subagents: the reading fills the agent's context, not yours. See [Subagents](#subagents).
- The model menu, then **Paramètres de génération…** (Generation settings), shows the size of the window and the space kept for the answer. **Régler** (Adjust) leads there to the compaction threshold.
- The **Pourcentage** and **Anneau** (Ring) forms of the gauge take less room in the composer.

### How it works

At each turn, the model rereads the assistant's instructions, your memory and your skills, the description of the active tools, the whole history (tool results included) and your new message. All of it must fit in the context window, whose size depends on the chosen model. When it fills, the older turns are summarized (compaction); as a last resort, the oldest messages are removed.

## Conversations
<!-- aide: conversations -->

Each exchange with the assistant is a conversation, kept in the sidebar. You can find it again, rename it, archive it, export it or delete it.

### The essentials

1. Click **Nouveau chat** (New chat), at the top of the sidebar, or press `Ctrl+Shift+O`.
2. Send your first message. The conversation is saved and gets a title, written by the model.
3. To come back to it, click its title under **Conversations**. Conversations are sorted by date: **Aujourd'hui** (Today), **Hier** (Yesterday), **7 derniers jours** (Last 7 days), **Plus ancien** (Older).
4. To act on a conversation, right-click its title, or open the **Conversation** menu (the three dots at the top right of the thread). Both offer **Renommer…** (Rename), **Rechercher** (Search), **Exporter** (Export), **Archiver** (Archive) and **Supprimer** (Delete).

A dot to the right of a title shows that an answer is in progress in that conversation.

### Finding a conversation

[Searching for a conversation by its title and opening it](media/aide/conversations-rechercher.webm)

1. Click the **Rechercher un chat** (Search for a chat) magnifying glass, to the right of **Conversations**.
2. Type a few letters of the title. The **Résultats** (Results) list updates with each keystroke.
3. Click a result to open it. `Esc`, or the field's cross, closes the search.

The search covers titles. To find a word in the text, open the conversation and search inside it.

### Searching within a conversation

[Searching for a word in the open conversation](media/aide/conversations-chercher-dans-le-fil.webm)

1. Open the **Conversation** menu, then click **Rechercher**.
2. Type the word in the **Rechercher dans la conversation...** (Search in the conversation) field. It is highlighted in the messages that contain it; the other messages fade. A counter shows "2 résultat(s)" (2 results).
3. `Enter` goes to the next result, `Shift+Enter` to the previous one. `Esc` closes the search.

From the right-click menu on another conversation, **Rechercher** opens it and shows the field. The search closes when you change conversation.

### Renaming

[Renaming the conversation with a double-click on its title](media/aide/conversations-renommer.webm)

1. Double-click the title, at the top of the thread.
2. Type the new name.
3. `Enter` confirms, `Esc` cancels.

**Renommer…** in the menu opens the **Renommer la conversation** (Rename the conversation) window: type the name, then **Valider** (Confirm). In the sidebar, `F2` does the same for the conversation selected with the keyboard.

### Archiving

Archiving removes a conversation from the list without deleting it.

1. In the conversation menu, click **Archiver**. It leaves the list at once, without confirmation.
2. A message, for example "« Budget formation 2027 » archivée" ("Budget formation 2027" archived), offers **Annuler** (Undo) for a few seconds.

Archives are found in Paramètres (Settings) › **Avancé** (Advanced) › **Archives**. **Restaurer** (Restore) puts a conversation back in the list, **Supprimer** deletes it permanently. **Sélection** (Select) lets you tick several, then restore or delete them together.

### Deleting

[Deleting a conversation with a right-click](media/aide/conversations-supprimer.webm)

1. Right-click the conversation, then click **Supprimer**.
2. Confirm the question "Supprimer la conversation ?" (Delete the conversation?) with **Supprimer**.
3. The message "Conversation supprimée" (Conversation deleted) offers **Annuler** for 5 seconds. After that, the deletion is permanent.

If background tasks are running for this conversation, the confirmation warns you that they will be stopped.

### Acting on several conversations

[Ticking three conversations and archiving them](media/aide/conversations-selection.webm)

1. Click **Sélectionner** (Select), next to the magnifying glass. A box appears in front of each title.
2. Tick the conversations. The sidebar shows "3 sélectionné(s)" (3 selected).
3. At the bottom of the sidebar, click **Archiver (3)** or **Supprimer**.

What to know:

- Bulk archiving can be undone from the message "3 conversation(s) archivée(s)" (3 conversations archived), with **Annuler**.
- Bulk deletion asks for confirmation and cannot be undone: "Cette action est irréversible." (This action is irreversible.)
- The **Terminer la sélection** (End selection) cross leaves the mode without doing anything.
- To erase everything at once: Paramètres › **Chat** › **Conversation**, **Effacer les conversations** (Clear conversations), then **Effacer** (Clear). All active conversations are deleted; archives are not touched.

### Exporting

[Opening the Conversation menu and choosing an export format](media/aide/conversations-exporter.webm)

1. Open the **Conversation** menu, then click **Exporter**.
2. Choose **Markdown**, **JSON**, **Texte brut** (Plain text) or **PDF**.

The first three formats download a file. **PDF** opens a printable version in a new tab and starts printing: choose saving as PDF in your browser's window.

### The number of conversations kept

The application keeps a limited number of active conversations, set by the administrator. Beyond it, the oldest are deleted. Archived conversations do not count toward this limit: archiving is the way to keep a conversation as long as you want.

### Getting the most out of it

- The right-click on a title gives the same menu as the three dots: no need to open the conversation to rename, archive or delete it.
- The sidebar search reads only titles. Give a meaningful title to the conversations you will want to find again.
- Export as **Markdown** to take the exchange into a document, as **JSON** to also keep the measurements of each answer.
- If a conversation shows "Cette conversation n'existe plus." (This conversation no longer exists), it was deleted from another tab or another computer. The list updates by itself.

## Subagents
<!-- aide: agents -->

On a large piece of work, the assistant can hand part of the mission to a subagent. The subagent works on its own side, with its own tools and its own context, then returns a report. Your conversation receives a few paragraphs of conclusions, not the dozens of files that had to be read.

### The essentials

[Turning on subagents from the Agents page](media/aide/agents-activer.webm)

1. In the sidebar, click **Plus** (More), then **Agents**.
2. Turn on the **Sous-agents** (Subagents) switch, at the top right. The label changes from "Désactivés" (Off) to "Activés" (On).
3. Go back to the chat and make your request. The assistant decides by itself whether to delegate; you can also ask it to.

Subagents are off by default. If **Agents** does not appear in **Plus**, or if the switch says "Désactivés par l'administrateur" (Turned off by the administrator), ask your administrator.

### Following and stopping an agent

[Opening the window of an agent at work, then reading its report](media/aide/agents-suivi.webm)

Each delegation adds a line in the answer: the agent's name, its mission and its context in tokens.

1. While the agent works, click the eye, **Voir le déroulé de l'agent** (View the agent's progress).
2. The agent's window shows **Consigne reçue** (Instruction received), what the assistant asked of it, and **Déroulé** (Progress), its steps live.
3. At the end, it adds **Bilan** (Summary; status, number of tool calls, duration) and **Rendu à l'assistant** (Returned to the assistant), its report. **Copier** (Copy) copies it.
4. Close the window. The agent's line now carries its status, and the assistant answers from the report.

What to know:

- To stop an agent, click the **Arrêter cet agent** (Stop this agent) cross on its line, or **Arrêter** (Stop) in its window. Only this agent stops: the assistant carries on.
- **Détails** (Details), on the line, unfolds the modified files, the commits and the budget warnings.
- The status comes from the agent's report, corrected by what the application observes: "terminé" (done), "partiel" (partial), "bloqué" (blocked), "statut inconnu" (unknown status), "budget épuisé" (budget exhausted), "délai dépassé" (timeout), "indisponible" (unavailable), "erreur" (error) or "annulé" (cancelled).
- The green check mark is shown only for an agent that is "terminé". A `verify` agent whose tests fail did finish its work, but carries "vérification échouée" (verification failed).
- After the end, the eye stays on the line when the agent has a progress record to show.
- Review the work of an agent that writes before considering it done: the diff, or a `verify` agent.

### The Agents page

The page shows agents as cards. Under **Livrés** (Shipped), five agents are ready to use:

- `explore`: explore read-only. Locate, read, judge, go back through the Git history.
- `implement`: write the change in the sandbox and check it, without committing.
- `verify`: run the tests and commands, diagnose failures, change nothing.
- `web`: search the web by driving a real browser, read-only.
- `pr`: branch and commit work already in place, then prepare the merge request.

On each card:

- the **Actif** (Active) switch removes the agent from, or puts it back among, those the assistant can choose;
- a strip shows what it can do: **Lire** (Read), **Modifier** (Edit), **Terminal**, **Git**, **Web**;
- its budget is expressed in tool calls, for example "60 appels" (60 calls), followed by "réflexion" (reasoning) if it reasons before acting.

The description of the shipped agents is in English: it is the text the assistant reads to choose. A click on a card opens the agent's sheet. You can edit a shipped agent: **Réinitialiser** (Reset) then restores the original template, **Dupliquer** (Duplicate) makes it a personal agent.

### Creating a personal agent

1. Under **Personnels** (Personal), click **Nouvel agent** (New agent). You can have up to 30.
2. **Général** (General) tab: the **Nom** (Name; lower case letters, digits, `-` and `_`, 32 characters at most), the **Description** (one line, in English, read by the assistant to choose this agent) and the **Budget** in tool calls. Left empty, the budget takes the default value.
3. **Outils** (Tools) tab: the tool **Catégories** (Categories), and the **Serveurs MCP** (MCP servers) the agent connects to, even if they are not active in the chat.
4. **Droits** (Permissions) tab: **Fichiers** (Files), **Réflexion** (Reasoning) and, for an agent that has web tools, **Navigateur** (Browser). A line under each choice says what it changes.
5. **Instructions** tab: the text read by the agent, in English. **Gabarit** (Template) inserts the structure of the shipped agents.
6. Click **Enregistrer** (Save). The agent exists only for your account.

You can also have it written for you. Click **Assistant**, at the top of the page, or the **Créer avec l'assistant** (Create with the assistant) card as long as you have no personal agent. Give a name and the mission. The assistant asks two rounds of questions at most, writes the sheet, shows it to you, then saves it after your agreement. The agent is created turned off: read it over, then turn it on from the page (**Ouvrir dans Agents** (Open in Agents) button under the result).

### An agent's permissions

- **Fichiers**: **Écriture** (Write) or **Lecture seule** (Read-only). Read-only, the agent only reads and searches: nothing is changed, and the terminal is taken away from it. `explore` and `web` are shipped this way; `web` keeps its browser. The note "Imposé par l'administrateur" (Imposed by the administrator) marks a choice you cannot change.
- **Réflexion**: **Comme la conversation** (Like the conversation), **Activée** (On) or **Désactivée** (Off). Without effect if the model does not reason.
- **Navigateur**: in **Session privée** (Private session), the agent browses in an empty session, without your sign-ins, closed at the end of its mission. With **Ma session web** (My web session), it uses your signed-in session and acts on sites as you. The administrator can forbid this second choice.

Two precautions:

- On an external MCP server, a read-only agent can call only the tools that this server declares read-only. The others are refused to it.
- No agent publishes with the application's Git tool: `pr` prepares the branch and the commit, then the assistant pushes, in the chat, in front of you. This rule does not cover an external MCP server able to publish: attach to an agent only servers that you accept it to use on its own.

### The limits

- A subagent does not delegate in turn, has no task list, does not start background tasks and does not ask you questions.
- It starts knowing nothing of the conversation: the assistant writes it a complete instruction.
- A turn launches 12 agents at most by default. At the ceiling, the assistant finishes with what its agents reported, or asks you how to continue.
- A mission lasts one hour at most by default. At the deadline, the agent stops and returns a partial report, which the assistant can pick up again.
- Agents launched by the same message start together. When another agent was writing at the same time, **Détails** says so: some modified files may be its own.
- The assistant delegates neither in plan mode nor in a routine.
- The administrator sets these ceilings and can turn off subagents for everyone.

### Background agents

For a long mission it does not need right away, the assistant can launch an agent in the background. The agent's line then carries "en fond" (in the background). The assistant hands control back to you. The report arrives later: it joins the work in progress, or restarts the conversation if the assistant had finished.

- The answer's stop button does not stop it. Use its cross, or **Arrêter** in the background task list, where it carries the note "sous-agent" (subagent).
- The **Ne pas me réveiller dans cette conversation** (Do not wake me in this conversation) setting applies to it as well. See [When the assistant acts](#when-the-assistant-acts).

### Getting the most out of it

- `/agents on` and `/agents off` turn subagents on and off without leaving the chat; `/agents open` opens the page.
- Name the agent in your request when you know which one fits: "lance un agent `explore` pour trouver où est calculé le solde" (launch an `explore` agent to find where the balance is computed).
- Open the eye during the work rather than after: you see the current step and can stop an agent heading in the wrong direction, without losing the rest of the turn.
- Turn off the **Actif** switch of the agents you do not want chosen, for example `web` or `pr`.
- An agent that ends on "budget épuisé" is short of tool calls: raise its **Budget** in the **Général** tab.
- A personal agent connected to an MCP server makes a good librarian: it searches your wiki or your ticket tool and reports only the answer. Leave it on **Écriture** if the server's tools do not declare themselves read-only.
- After an `implement` agent, ask for a `verify` agent: it runs the tests without changing anything.
- If you stop the answer while an agent is working, **Continuer** (Continue) lets the assistant pick it up where it was.

## Tools and the MCP panel
<!-- aide: mcp -->

Tools let the assistant act instead of only writing: read a file, run a command, open a web page. The **MCP** panel sets which tools it has in the current conversation. The panel is named after the protocol that connects the assistant to its tools (*Model Context Protocol*).

[Open the MCP panel, turn on two categories, then remove one specific tool](media/aide/mcp-categories.webm)

### The essentials

1. Click **MCP** in the sidebar. The panel opens to the right of the conversation.
2. Under **Internes** (Internal), turn on the switch of each category your request needs.
3. Write your message. The assistant chooses for itself which of the active tools to call.
4. Each call appears in its reply, with its parameters and its result: see [When the assistant acts](#when-the-assistant-acts).

The switches belong to each conversation and are saved with it. Reopening yesterday's conversation restores the tools that were active. A new chat starts with the categories your administrator chose as defaults.

### The tool categories

Turning on a category gives the assistant all of its tools.

| Category | What the assistant can do |
|---|---|
| **Fichiers** (Files) | Read, write and edit the files in your sandbox, list them, move them, browse the structure of a codebase |
| **Terminal** | Run commands in your sandbox, including long tasks in the background |
| **Git** | Clone a repository, check its status, create a branch, commit, push and open a merge request |
| **Navigateur** (Browser) | Drive a browser: open a page, click, fill in a form, check a result |
| **Contrôle d'écran** (Screen control) | Observe and drive a machine connected to the application |
| **Graphiques** (Charts) | Produce charts and tables from data |
| **Documents Office** (Office documents) | Create, read and edit Word and PowerPoint documents, export them to PDF |
| **Skills** | Read the details of a skill and save new ones |

The list depends on the installation. If a category is missing, or if the panel says "Aucune catégorie d'outils active pour le moment" (No tool category active at the moment), ask your administrator.

A few tools have no switch in the panel:

- the task list the assistant keeps during long work (the **Tâches de la session** (Session tasks) chip, in the composer);
- delegation to [subagents](#subagents), if you have turned them on;
- memory, which is set in Paramètres › **Mémoire** (Memory) (see [Memory](#memory)).

### Choosing the tools of a category

You can keep a category while removing some of its tools.

1. Turn on the category.
2. Click the chevron to the right of its name (**Choisir les outils**, Choose the tools): the list of its tools unfolds.
3. Clear the ones the assistant must not use. A counter, for example `5/6`, appears next to the name.
4. **Tout** (All) ticks them all again. The information icon at the end of the line opens the **Détail de l'outil** (Tool details).

### External servers

An external MCP server brings the tools of another service: a software forge, a wiki, an internal database. The **Externes** (External) section of the panel lists the ones you chose to display. Each one is turned on with its switch, like a category, for the current conversation.

[Show a server published by the administrator in the panel, then turn it on](media/aide/mcp-serveur-externe.webm)

#### Using a server published by the administrator

1. In the **Externes** section, click **+** (**Gérer / ajouter un serveur**, Manage / add a server). The **Serveurs MCP** (MCP servers) window opens.
2. On the left, under **Partagés** (Shared), click the server.
3. Turn on **Afficher dans le panneau** (Show in the panel), then close the window.
4. The server now appears under **Externes**. Turn on its switch in each conversation where you need it.

Its credentials are managed by the administrator: you have nothing to enter.

#### Adding your own server

1. In the **Serveurs MCP** window, click **Ajouter** (Add).
2. If your service appears in the **Modèle** (Template) line (**Jenkins**, **Wiki.js**), click it: the fields are prefilled.
3. Fill in the **Nom** (Name), the **Type** (**HTTP** or **SSE**, according to the service's documentation) and the **Adresse** (Address).
4. Choose the authentication in **Auth**:
   - **Aucune** (None);
   - **Jeton (Bearer)** (Token): the token alone, without the word "Bearer";
   - **Basic**: a user name and a password or a token;
   - **Clé d'API** (API key): the header name and its value;
   - **Authorization brut** (Raw Authorization): the full value of the header.
5. If the service asks for other headers, add them with **+ En-tête** (+ Header).
6. Click **Tester** (Test). The application queries the server without saving anything, then shows the number of tools found or the error.
7. Click **Ajouter**. The server appears under **Mes serveurs** (My servers) and in the **Externes** section of the panel.

Good to know:

- The secrets you enter are stored encrypted by the application and are never shown again. When you reopen the server, the fields say "inchangé" (unchanged): leave them empty to keep the value, or type it again to replace it.
- An internal address (the server's own machine, the company's private network) is refused to an ordinary account: "Adresse de serveur MCP refusée" (MCP server address refused). These servers must be published by an administrator. Ask them to do it, then follow the steps of the previous section.
- To edit a server, choose it on the left, change its fields, then **Enregistrer** (Save). If you close before saving, the **Modifications non enregistrées** (Unsaved changes) banner offers **Abandonner** (Discard) or **Enregistrer**.
- **Supprimer** (Delete) asks for a second click on the same button to confirm.

### Getting the most out of it

- Less is often better. Each active category adds the description of its tools to what the assistant has to read. For a pure writing question, turning everything off makes the answer faster and more direct.
- To let the assistant read without changing anything, keep **Fichiers** and clear `write_file`, `edit_file` and `manage_files` in its tool list.
- The settings follow the conversation. Keep one "read-only" conversation to explore a project and another, with **Terminal** and **Git**, to change it.
- **Contrôle d'écran**: once the category is on, the **Cible** (Target) list chooses the machine to drive.
- In the **Serveurs MCP** window, the **Rechercher** (Search) field filters the list, and the `↑` and `↓` arrows move from one server to the next.
- Turning off **Afficher dans le panneau** removes a server from the panel without deleting it.
- A [routine](#routines) chooses its own tools, in its **Outils** tab: the tools of your conversations do not apply to it.
- To remove all tools at once, turn off **MCP** in Paramètres › **Fonctionnalités** (Features) › **Modules**. The assistant can then only write, only memory remains, and the **MCP** entry leaves the sidebar.
- The **MCP** panel and the [generation settings](#models-and-providers) panel take the same place: opening one closes the other.

### Using your tools from another application

If the administrator allows it, a code editor, a command-line assistant or a script can use the same tools as your conversations. Each call runs in your sandbox, under your account.

1. Open Paramètres › **Secrets** › **Jetons MCP** (MCP tokens), then click **Nouveau jeton** (New token).
2. Give it a **Nom**, tick the **Familles d'outils** (Tool families) to hand over, set the **Durée de validité** (Validity period), then click **Créer** (Create). The browser and screen control are never ticked by default.
3. Copy the token right away: it is shown only once.
4. Copy the configuration block offered for your client. The **MCP**, **VS Code** and **opencode** tabs are for clients that speak MCP. The **OpenAPI** and **curl** tabs are for platforms and scripts that do not.

An MCP client that handles authorization itself does not need a token. On its first connection, it opens the **Autoriser l'accès à vos outils** (Allow access to your tools) page: tick the families, then **Autoriser** (Allow). These accesses are removed under **Applications autorisées** (Authorized applications), with **Retirer l'accès** (Remove access).

On each token, **Régénérer** (Regenerate) replaces its value and **Révoquer** (Revoke) cuts it off; **Tout révoquer** (Revoke all) cuts off all your tokens. If the tab says that tool tokens are disabled, ask your administrator.

### How it works

The file, terminal and Git tools work in your sandbox, not on the server or in another user's space: see [The sandbox and the code editor](#the-sandbox-and-the-code-editor). The course of a tool turn is described in [When the assistant acts](#when-the-assistant-acts).

## The sandbox and the code editor
<!-- aide: editeur -->

The sandbox is your private workspace on the server: the assistant writes, runs and tests code there without touching your computer. The code editor gives you access to it, next to the chat: files, tabs, Git, preview and snapshots.

[Open the sandbox, unfold a folder and open a file](media/aide/editeur-ouvrir.webm)

### The essentials

1. Click **Sandbox** in the sidebar. The editor opens to the right of the chat.
2. In the explorer, click a folder to unfold it, then a file to open it in a tab.
3. Edit the file, then save with `Ctrl+S`.
4. Click **Sandbox** again, or **Fermer** (Close) at the top right of the editor, to close the panel.

Drag the left edge of the editor to widen it; **Plein écran** (Full screen) gives it the whole window, and `Esc` leaves it. When the editor is narrow, the explorer sits over the code and folds as soon as a file opens: the **Explorateur de fichiers** (File explorer) button, at the top left, or `Ctrl+B` brings it back. If the **Sandbox** entry is missing from the sidebar, turn on **Sandbox** in Paramètres (Settings) › **Fonctionnalités** (Features) › **Modules**.

### The file explorer

At the top, three icons switch views: **Fichiers** (Files), **Git** (with the number of modified files) and **Historique** (History).

- **Nouveau fichier** (New file) creates a file. The **Actions des fichiers** (File actions) menu (« ⋯ ») gathers **Nouveau dossier**, **Importer des fichiers**, **Importer un dossier**, **Fichiers cachés**, **Localiser le fichier ouvert**, **Tout replier** and **Actualiser** (New folder, Import files, Import a folder, Hidden files, Locate the open file, Collapse all, Refresh).
- Right-clicking a file or a folder offers **Nouveau Fichier**, **Nouveau Dossier**, **Terminal ici**, **Renommer**, **Dupliquer**, **Copier le chemin**, **Télécharger** and **Supprimer** (New file, New folder, Terminal here, Rename, Duplicate, Copy the path, Download, Delete); for a file, **Joindre au chat** (Attach to the chat) adds it to your next message.
- Drag a file onto a folder to move it. Drag files or whole folders from your computer to import them, even large ones: a bar shows the progress and lets you cancel.
- The **Rechercher...** (Search...) field looks for text in all the files. **Contenu** (Content) and **Nom** (Name) switch the mode; `Aa` matches case, `.*` accepts a regular expression, a filter (`*.py`) limits the search.
- In a Git repository, a letter follows each touched file: `M` modified, `U` untracked, `A` added, `D` deleted, `C` in conflict. A dot marks the folders that contain changes.
- When a disk quota applies, the gauge at the top right of the editor shows the share used.

### Editing and saving

[Edit a file then save it from the editor menu](media/aide/editeur-modifier.webm)

1. Type in the code. A dot appears on the tab and the status bar, at the bottom, shows **non sauvegardé** (not saved).
2. Save with `Ctrl+S`, or from the **Plus d'actions** menu (« ⋯ », at the top right) › **Enregistrer** (Save).
3. The dot disappears and the status bar shows **sauvegardé** (saved).

**Tout enregistrer** (Save all) (`Ctrl+Alt+S`) saves all the modified tabs; closing a modified tab first asks whether to save it. The code is colored according to the file extension, for more than thirty languages, including Robot Framework. The status bar also shows the Git branch, the cursor position, the file's errors and warnings (click to list them), the language, the indentation, the encoding and the line endings (click `LF` or `CRLF` to convert).

### Finding a file and managing tabs

[Find a file from a few letters of its name with Ctrl+P](media/aide/editeur-ouverture-rapide.webm)

1. Press `Ctrl+P`.
2. Type a few letters of the name. With no input, recent files come first.
3. Choose with the arrows and `Enter`, or click. The file opens in a new tab.

Right-clicking a tab offers **Fermer**, **Fermer les autres**, **Fermer ceux à droite**, **Tout fermer**, **Ouvrir à droite (vue scindée)**, **Copier le chemin**, **Localiser**, **Épingler**, **Joindre au chat** and **Tout enregistrer** (Close, Close the others, Close those on the right, Close all, Open on the right (split view), Copy the path, Locate, Pin, Attach to the chat, Save all). Drag a tab to move it. When the tabs overflow, a "+N" button lists them.

### Comparing and going back

- The **Versions** button, at the end of the file path, compares the tab with **La sauvegarde** (what is saved), **Le dernier commit** (in a Git repository) or **L'original** (the file at the start of your session). The differences are shown in color; click the same choice again to return to the code.
- The **Historique** view of the explorer lists the files modified since you logged in, by you or by the assistant. Unfold a file: each version can be compared with the tab or restored into it.
- When the assistant writes a file, the editor opens it and briefly tints the modified lines; the **Ouverture automatique** (Automatic opening) and **Surbrillance des modifications** (Change highlighting) settings, in Paramètres › **Fonctionnalités** › **Éditeur** (Editor), turn either one off. If it rewrites a file that you are editing, a banner says so: your changes are kept, **Comparer** (Compare) shows them and **Restaurer** (Restore) takes them back.
- If an open file changes on disk, after a terminal command for example, a banner offers **Comparer**, **Recharger** (Reload) or **Écraser** (Overwrite).

### The AI actions

[Have a passage of code explained, then accept the proposal](media/aide/editeur-ia.webm)

1. Select the lines concerned, then right-click inside the selection.
2. Under **Actions IA** (AI actions), choose **Expliquer ce code**, **Commenter (IA)**, **Refactoriser**, **Chercher des bugs**, **Optimiser**, **Ajouter docstring** or **Générer des tests** (Explain this code, Comment (AI), Refactor, Look for bugs, Optimize, Add docstring, Generate tests).
3. The proposal is shown as a comparison with your code. Click **Accepter** (Accept) to apply it, or **Rejeter** (Reject). An accepted proposal modifies the tab: save afterwards.

- **Expliquer ce code** and **Chercher des bugs** add a comment, **Générer des tests** adds the tests under the selection; the other actions rewrite the selection.
- **Compléter ici** (Complete here) (`Alt+\`) writes the continuation of the code at the cursor, with no selection, taking into account what comes before and after.
- **Demander au chat** (Ask the chat) copies the selection into the chat's input field, with the file path and the line numbers: all that is left is to ask your question.
- The same menu gives **Exécuter le fichier**, **Commenter / Décommenter**, **Formater le document**, **Aller à la définition**, **Trouver les références** and **Renommer le symbole** (Run the file, Comment / Uncomment, Format the document, Go to definition, Find references, Rename the symbol).

These actions need a model that can complete code. If a message says that completion is unavailable, ask your administrator.

### The preview

[Show an HTML page next to the code and watch it follow your typing](media/aide/editeur-apercu.webm)

The web page preview is turned on once, in Paramètres › **Fonctionnalités** › **Éditeur** › **Aperçu** (Preview).

1. Open an HTML file, then **Plus d'actions** (« ⋯ ») › **Aperçu à côté** (Preview alongside). The page appears to the right of the code.
2. Click **Live**: the page is saved and reloaded while you type. Without **Live**, it reloads each time you save.

The preview bar lets you change file, reload, open the page in a browser tab and close. The **Web** button, at the top of the editor, shows the preview alone, at full width.

To see an application running in your sandbox, switch the source from **Fichier** (File) to **Serveur** (Server) and enter its address: `localhost:8080`, a bare port (`8080`) or a full address (`http://localhost:5173/app`). This mode needs a connected network profile: with the isolated profile, the preview shows "Sandbox injoignable" (Sandbox unreachable).

[Show the rendering of a Markdown file next to its text](media/aide/editeur-apercu-markdown.webm)

For a Markdown or SVG file, **Plus d'actions** › **Aperçu Markdown** (or **Aperçu SVG**) shows the rendering next to the text, with no prior setting. The rendering follows your changes.

### Git

[Open the Git view and show a file's changes](media/aide/editeur-git.webm)

1. Click the **Git** icon of the explorer, or the branch name in the status bar.
2. The view lists the **Indexés** (Staged), **Modifiés** (Modified) and **Non suivis** (Untracked) files, with the lines added and removed.
3. Click a modified file: its changes since the last commit are shown in color.

[Stage the files, have the message proposed and confirm the commit](media/aide/editeur-git-commit.webm)

To record your changes in the repository's history:

1. Click **Tout indexer** (Stage all), or the "+" of a file to stage only that one.
2. Write the message in **Message de commit...** (Commit message...), or click the spark in the field: the assistant proposes it from the staged changes.
3. Click **Commit**. `Ctrl+Enter` in the message does the same.

| Need | In the Git view |
|---|---|
| **Dépôt et branche** (Repository and branch) | Two menus at the top: change repository; change branch (**Locales**, **Distantes**, Local, Remote) or create one (**Nouvelle branche**, New branch) |
| **Synchroniser** (Synchronize) | **Actualiser** (Refresh), **Pull**, **Push**; under « ⋯ »: **Fetch**, **Pull (rebase)**, **Push (force)**, **Remote...** |
| **Fusionner** (Merge) | **Merge**, with a preview before merging, and **Rebase**; in case of conflict, **Mienne** (Mine) or **Leur** (Theirs) file by file, **Annuler** (Cancel) to give up |
| **Mettre de côté** (Set aside) | **Stash** then **Stash Pop** |
| **Historique** (History) | « ⋯ » › **Historique**: click a commit to see its files, then a file to compare it |
| **Réparer** (Repair) | **Annuler dernier commit** (Undo last commit) adds a commit that cancels it; **Restaurer** (Restore), on a commit in the history, brings the repository back to it through a new commit |
| **Annuler** (Undo) | The arrow on a modified file discards its changes, after confirmation |

Exchanges with the Git server go through your Git accounts: no credential is written in the sandbox, and a private repository is cloned without typing anything. See [Secrets and Git accounts](#secrets-and-git-accounts).

#### Adding a repository

[Add a repository by choosing it from a Git account's list](media/aide/editeur-depot.webm)

1. In the **Git** view, click **Ajouter un dépôt** (Add a repository). If a repository already exists, click its name, then **Ajouter un dépôt...**.
2. Choose a way:
   - **Mes dépôts** (My repositories): the repositories of one of your Git accounts, within what it applies to. Choose the **Compte** (Account) if you have several, then a repository. The tab appears only if an account can list its repositories.
   - **Depuis une URL** (From a URL): paste an `http(s)` clone URL. An SSH URL is refused, with the reason.
   - **Nouveau dépôt** (New repository): an empty repository, created in the folder you name; with no name, at the root of your workspace.
3. Check the summary: **Dépôt** (Repository, as it was read), **Accès** (Access, the account that will be used) and **Dossier** (Folder, by default the repository name).
4. Click **Cloner** (Clone), or **Initialiser** (Initialize) for a new repository.

- The account chosen is the most specific one that covers the repository; the window says when none fits or when its token needs checking.
- With no account, or if access is refused, enter credentials on the spot: if the clone succeeds, they are saved as a Git account, and the window says when they are not. This also applies to a repository placed at the root of a server (`https://git.exemple/projet.git`), which no account covers.
- With `http://`, a Git account is only used on the local network; the window points out what then travels in clear text.
- Your commits are attributed to your account, the assistant's to "votre compte (Elpis agent)" (your account (Elpis agent)), on `agent/…` branches.

### Snapshots

A snapshot captures all the files in your sandbox at a given moment. Take one before letting the assistant work on its own, or before a risky operation.

[Create a named snapshot from the editor menu](media/aide/editeur-snapshots.webm)

1. Open **Plus d'actions** (« ⋯ ») › **Snapshots**.
2. Give it a name; with no name, it carries the date and time.
3. Click **Créer une snapshot** (Create a snapshot). It joins the list, with its number of files, its size and its date.

[Restore a snapshot: the files return to the captured state](media/aide/editeur-snapshot-restaurer.webm)

To go back to it, click the **Restaurer** icon of the snapshot, then confirm with **Restaurer**. All current files are replaced by those of the snapshot, and open tabs are closed.

- Save or close the modified tabs first: the restoration is refused as long as some remain.
- The panel counter ("2/10") shows the number of snapshots kept, set by the administrator. Beyond it, the oldest are deleted. The trash can that appears on hover deletes a snapshot.
- If a restoration is interrupted, the panel says so: start it again.

### The editor style

The editor takes the style of the skin, or keeps the classic editor: the choice and its **Thème sombre** (Dark theme) are set in Paramètres › **Apparence** (Appearance) › **Éditeur** (see [Appearance](#appearance)). You can also switch in the editor, without losing any change in progress: « ⋯ » › **Éditeur classique**, then "+" › **Éditeur du skin** to come back. The classic editor names a few menu entries differently, for example **Sauvegarder** or **Snapshots de la sandbox**.

### Getting the most out of it

- The editor keys (open a file, switch tabs, multiple cursors) are in [Keyboard shortcuts](#keyboard-shortcuts); **Plus d'actions** › **Raccourcis** (Shortcuts) shows them in the editor. A command palette opens with `Ctrl+Shift+P`, and tabs close with `Alt+W`.
- **Plus d'actions** › **Exécuter** saves the open file and runs it in the terminal (Python, JavaScript, shell, Ruby, Perl, PHP, Lua, R, Go). For an HTML page, it opens the preview.
- Multiple selection in the explorer: `Ctrl`+click adds a file, `Shift`+click selects a range. Right-clicking then offers **Joindre au chat**, **Télécharger (zip)** and **Supprimer**.
- Replace in all files: run a content search, click **Remplacer dans les fichiers** (Replace in files), enter the new text, then **Aperçu** (Preview). Clear the files to spare and click **Remplacer** (Replace).
- Two files side by side: right-click a tab › **Ouvrir à droite (vue scindée)**.
- Paramètres › **Fonctionnalités** › **Éditeur** sets the font and its size, indentation, line wrapping, the minimap, line numbers, **Sauvegarde automatique** (Autosave) (after 30 s, 1 min or 2 min without typing, or when focus is lost), **Suivre le fichier ouvert** (Follow the open file) and **Mémoriser les onglets** (Remember tabs).
- Before handing a long task to the assistant, take a snapshot or make a commit. Afterwards, the **Git** or **Historique** view shows exactly what it changed.

### How it works

Each account has an isolated, persistent sandbox. Your working folder there is `/work`: the editor, the terminal and the assistant's tools all work in that same folder.

- **In your sandbox, you and the assistant have full rights**: `sudo` without a password, package installation, compilation. This is intended: this sandbox belongs to you alone. `sudo` is refused on a network profile limited to a list of addresses or with full access and a protection ticked, or when your administrator has turned it off: `pip install` and `npm install -g` still work (they install under `/work`); ask your administrator for the system packages you need.
- **The server and the other users are protected**: the sandbox is partitioned, with limits on memory, processor and processes.
- **The network is off by default.** The administrator defines network profiles (isolated, full access, list of allowed addresses) and you choose one, unless they impose one. A `pip install` or a `git clone` that fails with connection refused probably comes from that, not from an outage. The assistant knows what your sandbox really reaches: no network, only the allowed domains and ports (address ranges and DNS resolvers are only counted), or full access except what the profile refuses (cloud metadata, local network, host machine). It also knows which repositories its Git tools may reach through the Git relay, and when it has no `sudo`.
- **A disk quota applies**; the editor's gauge shows it.
- **An inactive sandbox is stopped automatically** and restarts on your next action. Your files do not move.

Paramètres › **Avancé** (Advanced) › **Sandbox** shows the state of the sandbox, its consumption, its limits and the **Réseau** (Network) profile. **Redémarrer** (Restart) restarts it. **Détruire** (Destroy) deletes it without touching your working folder: it will be recreated at next use. **Vider** (Empty), at the bottom of the page, permanently deletes all your files; your skills and your memory are not affected.

## The terminal
<!-- aide: terminal -->

The terminal is a real command line in your sandbox, under the editor. Use it to run tests, install a package or check what the assistant did.

[Open the terminal under the editor](media/aide/terminal-ouvrir.webm)

### The essentials

1. Open the editor: **Sandbox** in the sidebar.
2. Click the **Terminal** button, at the top right of the editor, or press `` Ctrl+` `` (Ctrl and backtick). The panel opens under the code, with a first tab named **Terminal 1**.
3. Click in the terminal and type your commands. The output appears in real time.
4. The cross at the right of the tab bar, **Masquer le panneau** (Hide the panel), folds the terminal without stopping it: whatever runs in it keeps running, and you find it again when you reopen the panel.

If your sandbox was stopped, a startup message appears the first time you open it, while it restarts.

### Several terminals

[Run a command, then open a second terminal](media/aide/terminal-commande.webm)

- The "+" button of the tab bar, **Nouveau terminal** (New terminal), opens another terminal in a new tab. You can open four; a counter appears as you near the limit.
- Click a tab to go back to it. Its dot is green when the terminal is connected; hover over the tab to read its state.
- Double-click a tab to rename it. `Enter` confirms, `Esc` cancels.
- The cross on a tab, **Fermer ce terminal** (Close this terminal), stops that terminal and whatever runs in it.

### Getting the most out of it

- `` Ctrl+` `` opens and folds the terminal without leaving the keyboard. The **Plus d'actions** (More actions) menu (« ⋯ ») › **Terminal** does the same.
- Right-click in the file explorer › **Terminal ici** (Terminal here): the terminal opens directly in that folder.
- **Plus d'actions** › **Exécuter** (Run) runs the open file in the terminal: see [The sandbox and the code editor](#the-sandbox-and-the-code-editor).
- In the output, a file path known to the explorer is clickable, like `src/calcul.py:12` or the line of a Python error: it opens the file at that line in the editor.
- Drag the top edge of the panel to enlarge it. Its height is remembered.
- After a command, the explorer, the open tabs and the Git view update by themselves.
- One terminal per task: a development server in one, the tests in another, each renamed. The preview in **Serveur** (Server) mode then shows the running application: see [The sandbox and the code editor](#the-sandbox-and-the-code-editor).
- You have full rights in your sandbox: `sudo apt install …` or `pip install …` work, if the network profile allows it (`sudo` is refused on a profile limited to a list of addresses or with full access and a protection ticked, or when the administrator has turned it off).

### How it works

The terminal runs in your sandbox and starts in your working folder. It uses the same user as the editor and the assistant: a file created on one side can be edited and deleted on the other. The sandbox's disk quota and network profile apply to it too.

- A terminal left idle for 30 minutes is closed automatically.
- If the connection is lost, the tab says so and reconnects by itself. After a server restart, the terminal starts again on a new shell and says so: the text already displayed stays, the running programs are stopped.

## Routines
<!-- aide: routines -->

A routine is a task the assistant runs without you: same tools, same skills, but started by a clock, by another service or by the end of another routine. For example: "every morning at 7, check the project's updates and give me a summary".

### The essentials

1. Click **Routines** in the sidebar. The page lists your routines on the left and shows the one you chose on the right.
2. Create a routine with **Assistant** (it asks you the questions) or with **Nouvelle** (New) (you fill in the form).
3. Let it work. Each run is added to its log, under **Exécutions** (Runs), and notifies you with a [notification](#notifications).

### Creating a routine with the assistant

The simplest way: say what you want to automate.

[Start the assistant from the Routines page, describe the goal, answer its first question](media/aide/routines-assistant.webm)

1. On the **Routines** page, click **Assistant**, at the top right. As long as you have no routine, the same button also appears in the middle of the page.
2. In the **Créer une routine avec l'assistant** (Create a routine with the assistant) window, write the **Objectif** (Goal). **Quand** (When) and **Résultat attendu** (Expected result) are optional. Click **Commencer l'entretien** (Start the interview).
3. A chat opens. The assistant asks its questions, in two rounds at most, in a questionnaire: see [When the assistant acts](#when-the-assistant-acts).
4. The assistant shows you the full draft: name, schedule, task. Ask for the corrections you want, then give your agreement.
5. It saves the routine, always **En pause** (Paused). Go back to the **Routines** page, read it over, then turn it on: see "Pausing, editing, deleting" below.

If the assistant writes the routine but cannot save it, check that **Créer des routines** (Create routines) is turned on in Paramètres (Settings) › **Fonctionnalités** (Features) › **Modules**.

### Creating a routine by hand

[Create a routine: its name, its schedule, its task, then "Créer"](media/aide/routines-creer.webm)

1. Click **Nouvelle**.
2. **Général** (General) tab: give a **Nom** (Name).
3. **Planification** (Schedule) tab: choose the frequency. The summary under the list says in plain words what will be done, for example "Chaque lundi, jeudi à 09:00" (Every Monday, Thursday at 09:00).
4. **Tâche** (Task) tab: write the **Tâche à exécuter** (Task to run).
5. **Outils** (Tools) tab: turn on the tools the task needs.
6. Click **Créer** (Create).

The name and the task are required. The four tabs contain:

| Tab | Contents |
|---|---|
| **Général** | **Nom**, the **Active** switch, the **Historique** (History) block (what the routine keeps and what it notifies) |
| **Planification** | Frequency, **Webhook**, **Enchaînement** (Chaining) |
| **Tâche** | **Serveur** (Server) and **Modèle** (Model), **Prompt système** (System prompt) (optional), **Tâche à exécuter**, **Mode réflexion (thinking)** (Reasoning mode) |
| **Outils** | **Outils locaux** (Local tools) (the categories of the MCP panel), **Serveurs externes** (External servers), **Skills attachés à la tâche** (Skills attached to the task) |

### Choosing when it runs

- **At a fixed time.** The list in the **Planification** tab offers **Toutes les X minutes** (Every X minutes), **Toutes les heures** (Every hour), **Tous les jours** (Every day), **Chaque semaine** (Every week) (tick the days), **Chaque mois** (Every month) and **Avancé (cron)** (Advanced). The times are the server's. In advanced mode, the expression follows the format `min hour day month weekday`, with Monday = 1 and Sunday = 7.
- **On demand.** Choose **Aucune (manuel / webhook)** (None (manual / webhook)): the routine starts only with the **Exécuter** (Run) button or through a webhook.
- **From another service (webhook).** Save the routine first. Reopen it with **Configurer** (Configure), **Planification** tab, then click **Générer un jeton** (Generate a token). Copy the **Jeton** (Token), shown only once, and the **URL**. In your forge, paste the URL and give the token as the webhook secret. Another sender can send the token in the `X-Webhook-Token` header. The **Événements** (Events), **Branche** (Branch) and **Dépôt** (Repository) fields restrict what triggers the routine. The same delivery received twice is handled only once. **Désactiver** (Disable) cuts off the webhook.
- **After another routine.** In the **Enchaînement** block, choose the routine under **Après** (After), then the condition under **Si** (If): **Succès** (Success), **Échec** (Failure) or **Toujours** (Always).

### Following the runs

[Open a log entry: the reason for a failure, then the reply and the file produced](media/aide/routines-suivi.webm)

In the list on the left, each routine shows the state of its last run, for example "Réussi · il y a 12 h" (Succeeded, 12 h ago), "En cours…" (Running...) or "Jamais exécutée" (Never run). On the right, **Exécutions** gives one line per run: state, trigger, date, duration, tokens used, number of files written and the start of the reply.

Click a line to unfold it. You find there:

- the assistant's full reply, or the reason for the failure;
- the **Fichiers produits** (Files produced): a click opens the file in the editor;
- the trigger and the token breakdown, input and output.

The possible states are **Réussi** (Succeeded), **Échec** (Failed), **En cours** (Running), **Arrêté** (Stopped) (you stopped it), **Ignoré** (Skipped) (it was not started: too many runs at the same time, or routine paused) and **Interrompu** (Interrupted) (the run could not finish, for example because the server restarted).

### Running a routine right now

["Exécuter" starts the routine: the line goes from "En cours" to "Réussi", then opens](media/aide/routines-executer.webm)

1. Choose the routine, then click **Exécuter**.
2. An **En cours** line appears at the top of the log. The page refreshes by itself.
3. At the end, the line changes to **Réussi** or **Échec**. Click it to read the reply.

During the run, **Arrêter** (Stop) interrupts it. A paused routine cannot be run: turn it back on first.

### Pausing, editing, deleting

[Pause a routine: "Configurer", the "Active" switch, "Enregistrer"](media/aide/routines-pause.webm)

1. Choose the routine, then click **Configurer**.
2. In the **Général** tab, flip the **Active** switch.
3. Click **Enregistrer** (Save).

A paused routine carries the **En pause** label and no longer starts at the scheduled time. The same action turns it back on: this is how you put a routine created by the assistant into service.

**Configurer** is also used to change anything. A dot before the title signals unsaved changes, and leaving the form then asks for confirmation. **Supprimer** (Delete), at the bottom left of the form, deletes the routine and its log after confirmation.

### Getting the most out of it

- In the chat, the `/routine` command followed by your goal opens the creation assistant directly, for example `/routine summarize the tickets every Monday`.
- Write a task that stands on its own. During a run, the assistant cannot ask you any question: say where to read, what to produce and where to write it.
- Think about tools. A routine created by hand has none: without **Fichiers** (Files) or **Terminal** in the **Outils** tab, it can only write a text.
- Attach [skills](#skills) in the **Outils** tab to give the routine a method, twelve at most. Ticking a package brings in all its skills.
- Adjust the noise in the **Historique** block: **Notifications** on **Échecs seulement** (Failures only) for a frequent routine, **Exécutions gardées** (Runs kept) and **Notifications gardées** (Notifications kept) to limit what is stored (0 = keep everything).
- Ask the routine to write its result in a dated file: you find it under **Fichiers produits**, run by run.
- Try a routine with **Exécuter** before relying on its schedule.
- Chain two simple routines rather than writing one complicated one: the second **Après** the first, **Si**: **Succès**.
- When you hover over the reply of a run, **Copier la réponse** (Copy the reply) puts it in the clipboard.

### How it works

- A routine works alone. It does not delegate to subagents, even if you use them in your conversations.
- Runs come after live conversations: they always give way to them.
- A run that fails right from the start is retried once, automatically.
- The number of simultaneous runs per account is limited, and so is the length of a chain of routines.
- The content received by a webhook and the summary of the previous routine are handed to the assistant as data, never as instructions: it is the routine's task that says what to do with them.
- The log keeps the first 4,000 characters of each reply.

## Your documents (RAG)
<!-- aide: rag -->

RAG lets the assistant answer from **your documents**, citing its sources. You put documents in a collection, turn it on in a chat, and the assistant looks for the useful passages in it before answering.

> RAG appears only if your administrator has set it up; they can reserve it for certain groups. If the **RAG** entry is missing, ask your administrator.

[Open the RAG page and create a first collection](media/aide/rag-collection.webm)

### The essentials

1. In the sidebar, open **Plus** (More), then **RAG**.
2. Click **Nouvelle collection** (New collection), give it a name, then click **Créer** (Create).
3. Click **Ajouter des documents** (Add documents) and choose your files. Wait for the **Prête** (Ready) state.
4. Click **Discuter avec** (Chat with): a chat opens, with the collection already on.
5. Ask your question. The reply carries numbered badges: each one leads to the passage cited.

### Creating a collection

A collection groups documents on the same subject. The RAG page lists **Mes collections** (My collections) on the left, then **Partagées avec moi** (Shared with me), and shows the space you use at the bottom.

- On your first visit, the page shows **Créez votre première collection** (Create your first collection). After that, the **Nouvelle collection** button is at the top right.
- The **Description** is optional, but the assistant reads it to know when to search this collection. One precise sentence is enough.
- You can also drag files onto the empty page: the **Nouvelle collection** window opens with a suggested name, and the files are dropped in as soon as you click **Créer**.

### Adding documents and following the indexing

[Drop files and follow their indexing until the Prête state](media/aide/rag-documents.webm)

1. Open the collection, **Documents** tab.
2. Click **Ajouter des documents**, or drag files or a folder into the zone at the bottom.
3. A box lists each file dropped: **Ajouté** (Added), **Déjà présent** (Already present) (same content: it is ignored) or **Refusé** (Refused) with its reason.
4. A banner follows the indexing. **Suspendre** (Pause) pauses it, **Annuler** (Cancel) stops it while keeping the documents already indexed.

Each row of the table shows the strip of its passages and its state: **En attente** (Waiting), **Extraction…** (Extracting...), **Indexation…** (Indexing...), then **Prête**. A failure shows its reason, for example **Sans texte : activez l'OCR** (No text: turn on OCR) or **Protégé par un mot de passe** (Password protected).

- Accepted formats: PDF, Word (docx), PowerPoint (pptx), Excel (xlsx), HTML, Markdown, text, CSV, JSON and YAML.
- Default limits: 2 GB in total, 10 collections, 200 MB per file, 2,000 documents per collection. The administrator can change them.
- **Importer depuis la sandbox** (Import from the sandbox) adds files from your sandbox: tick them, then click **Importer** (Import). See [The sandbox and the code editor](#the-sandbox-and-the-code-editor).
- When you hover over a row, four icons appear: adjust the document's chunking, reindex it, open the original, remove it.
- **Filtrer les documents** (Filter the documents) searches by name; **Tous les états** (All states) keeps only the **Prêts** (Ready), **En cours** (In progress), **En attente** or **En échec** (Failed) documents.

### Testing a collection

[Ask a question in the Tester tab and read the passages found](media/aide/rag-tester.webm)

The **Tester** (Test) tab shows what the assistant would find, without opening a chat.

1. Open the **Tester** tab and type a question, as in a conversation.
2. Click **Chercher** (Search), or press `Enter`.
3. **Où se trouvent les passages** (Where the passages are) draws one strip per document: the numbered boxes are the passages kept, in order of relevance.
4. **Ce que l'assistant recevra** (What the assistant will receive) lists these passages, with the words of your question highlighted, and their estimated cost in tokens.

Three search modes: **Mixte** (Mixed) (meaning and words, the default), **Par le sens** (By meaning), **Mots exacts** (Exact words). **Passages** sets the number of passages kept. **Reclasser** (Rerank) is active only if the administrator has configured this option.

### The menu and settings of a collection

The **⋯** button in the header offers **Importer depuis la sandbox**, **Ajouter un dossier…** (Add a folder...), **Réindexer tous les documents** (Reindex all documents), **Réglages** (Settings) and **Supprimer la collection…** (Delete the collection...).

The **Réglages** tab, reserved for the owner, contains:

- **Nom** (Name) and **Description**;
- **Découpage** (Chunking): the method (**Automatique** (Automatic) suits most files) and the size of the passages. A change asks for confirmation, then reindexes the documents;
- **OCR des documents scannés** (OCR of scanned documents): turn it on to read PDFs with no text. The switch stays grayed out if the administrator has not provided for this reading;
- **Zone de danger** (Danger zone): **Vider…** (Empty...) deletes the documents and keeps the collection; **Supprimer…** (Delete...) erases everything, after you type the name.

### Publishing a collection

[Publish a collection to the members of a group](media/aide/rag-publier.webm)

1. Click **Publier…** (Publish...).
2. Choose **Groupes** (Groups), then tick one or more groups you belong to. The window says how many accounts will have access.
3. Click **Publier**. The **Privée** (Private) badge in the header takes the name of the group.

- The accounts that gain access receive a notification. They can query the collection, not edit it.
- **Ouvrir les documents sources** (Open the source documents) decides whether they can open your original files. Without this option, they see only the passages found.
- **Tous les comptes** (All accounts) is offered only to administrators.
- To unpublish, reopen **Publier…**, choose **Privée**, then **Rendre privée** (Make private).

A collection published by another account appears under **Partagées avec moi**, in **Lecture seule** (Read only). You can browse it (**Documents** and **Tester** tabs), use it with **Discuter avec**, or remove it from your list with **Masquer de ma liste** (Hide from my list). **Afficher les masquées** (Show hidden), at the bottom of the list, brings it back.

The administrator sees the name, the author and the size of all collections and can delete one. They never read the content of a collection that is not open to them.

### Querying a collection in the chat

[Chat with a collection and get a sourced answer](media/aide/rag-chat.webm)

**Discuter avec** opens a new chat, with the collection already on. The active collections appear as badges above the composer; the cross on a badge removes it. With no active collection, the assistant searches no document.

In a chat that is already open, the `/rag` command does the rest.

[Turn on a collection in a chat with the /rag use command](media/aide/rag-commande.webm)

| Command | Effect |
|---|---|
| `/rag use <collection>` | Query this collection in this chat. The menu lists yours, then those shared with you |
| `/rag off` | Stop querying any collection |
| `/rag search <question>` | Show the passages found in the thread, with no reply from the assistant |
| `/rag add <collection>` | Index the attached files, or the sandbox files cited with `@`, into one of your collections |
| `/rag new <name>` | Create a collection with the attached files |
| `/rag status` | See the indexings in progress |
| `/rag open [collection]` | Open the RAG page |

### Reading the sources of a reply

[Hover over a source, then open the document at the passage](media/aide/rag-sources.webm)

- In the reply, each reference is a numbered badge. On hover, or with the keyboard, a bubble shows the document, the page, the section, the collection, the excerpt with the words of your question highlighted, and the relevance.
- Under the reply, the sources footer lists the documents cited. The **N passages lus, non cités** (N passages read, not cited) link unfolds what the assistant read without keeping.
- **Voir dans le document** (View in the document) opens a pane on the right. **Page** shows the actual page, with the passage highlighted in place; **Texte** (Text) shows the extracted text, with the neighboring passages.
- In this pane, the arrows and the numbers move from one cited source to the next. A strip shows where the passages are in the document.
- The button that opens the original appears only if you have the right to. For a shared collection without access to the sources, only the cited passage is visible.

### Getting the most out of it

- Take care over the **Description**: it is what tells the assistant when to search the collection.
- Go through **Tester** before chatting. Compare the three modes and look at the cost in tokens: if the right passages do not come up, rephrase the question or review the chunking.
- Repeat `/rag use` to query several collections in the same chat.
- `/rag search` checks what your documents contain without waiting for a written answer.
- From a chat, attach files with the **+** button (5 MB at most), then run `/rag add` or `/rag new`: the files are indexed without leaving the conversation.
- Hover over a collection's badge, above the composer, to reread its description.
- A failed document is restarted on its own, with its reindex icon: no need to reindex everything.

### How it works

Each document dropped is read (text, headings, tables, pages), then cut into passages. Each passage is indexed by its meaning and by its words. When the question calls for it, the assistant looks for the useful passages in the active collections, reads their neighbors if needed, then answers, citing each passage by its number.

The passages remain **data**: the assistant does not follow instructions a document might contain. A passage taken from another account's collection carries the name of its author. When an account is deleted, its collections are too: those who were reading them are warned, and answers already given keep their excerpts, without being able to reopen the document.

## Skills
<!-- aide: skills -->

A **skill** is a procedure written in Markdown: *how* to do something concrete with your own tools, for example deploying to pre-production or writing an incident report. The assistant follows the procedure instead of improvising the steps.

[Pin a skill to the next message with /skills](media/aide/skills-epingler.webm)

### The essentials

1. In the composer, type `/skills`, then press `Enter`.
2. Choose a skill from the list. A few letters are enough to filter it.
3. The skill appears as a badge above the input.
4. Write your request and send: the assistant receives the procedure with your message.

The pin applies to **the next message** only. The cross on the badge removes it before sending.

You do not have to pin: the assistant knows the list of your skills and can open by itself the one that matches the request. Pinning guarantees it starts from the right procedure.

### Browsing the library

[Switch from Global to Perso and open a skill's details](media/aide/skills-bibliotheque.webm)

1. Open Paramètres (Settings) (the gear icon, at the bottom of the sidebar) › **Skills**.
2. Choose a part: **Global**, the library shared by all accounts, or **Perso** (Personal), your skills.
3. Click a skill to open its details: description, tags, then the **Corps** (Body), the procedure itself.
4. **← Skills** goes back to the list.

- **Filtrer les skills…** (Filter the skills...) searches the name, description, domain and tags. If the result is in the other part, a link says so and takes you there.
- In the details, **Rendu** (Rendered) shows the formatted procedure, **Source** its raw text.
- A skill can bundle files and scripts. A paperclip indicates it; the arrow to the left of its name unfolds its files.
- A skill filed in a domain appears in a folder of that name, which you unfold.

### Creating a skill

[Create a personal skill with the Nouveau form](media/aide/skills-creer.webm)

1. In Paramètres › **Skills**, click **Nouveau** (New).
2. Give it a short **Nom** (Name), in lower case with hyphens, for example `prise-astreinte`.
3. Fill in the **Description**: say when and why to use this skill.
4. Write the procedure in **Corps (markdown)**: numbered steps, the exact commands, the pitfalls.
5. Click **Créer** (Create). The skill appears in **Perso**.

- **Domaine (optionnel)** (Domain (optional)) and **Tags** are used to file and find your skills.
- **Assistant** opens a conversation that creates the skill with you: the assistant asks the questions, writes the procedure and saves it.
- In the details of one of your skills, **Éditer** (Edit) modifies it and **Supprimer** (Delete) erases it. The **Global** skills cannot be edited from an ordinary account.

### Importing and exporting

- **Importer** (Import) accepts three forms: **Archive .zip**, **Dossier de skill** (Skill folder) (the `SKILL.md` file and its attached files) or a single **Fichier SKILL.md**. You can also drag one of them onto the tab.
- **Exporter .zip** (Export .zip), in a skill's details, downloads it with its files. It is the way to pass it to a colleague or to keep it aside.

### The "Learned" skills

In **Global**, a **Learned** group may appear. These are drafts awaiting review by an administrator. The assistant does not use them until they are validated. Only an administrator can create them, edit them or move them into the shared library.

### Getting the most out of it

- The composer's **+** button also offers **Skills**, under **Insérer** (Insert): tick several at once.
- If what you type after `/` matches no command, the menu searches the skills directly: `/` followed by the first letters of a name is often enough to find it.
- Take care over a skill's **Description**: it is what the assistant reads to decide whether to open it. Put in it the words you will use in your requests.
- A personal skill with the same name as a **Global** skill replaces it for you.
- Write a skill as soon as you explain the same procedure for the second time. The **Assistant** button does it in a few questions.
- `/settings skills` opens the library directly from the chat.

### How it works

Skills are the memory of procedures. They complete two other memories:

| Memory | Contents |
|---|---|
| [Memory](#memory) | **Facts**: your profile, your environment, your decisions |
| A conversation's task list | The **steps** of the work in progress |
| **Skills** | **How to do** a specific task |

With each message, the assistant receives the list of your skills, with their name and description. When a request matches one of them, it can open its content before acting. It can also read the files attached to a skill and run its scripts. A pinned skill, for its part, is attached to the message automatically.

## Memory
<!-- aide: memoire -->

Long-term memory keeps what the assistant learns about you from one conversation to the next: your role, your preferences, the lasting facts of your environment. You no longer have to repeat them in each new chat.

It is **off by default**: nothing is remembered until you turn it on.

[Open long-term memory with /memory](media/aide/memoire.webm)

### The essentials

1. In the composer, type `/memory`, then press `Enter`. You can also open Paramètres (Settings) › **Mémoire** (Memory).
2. Turn on the **Activer la mémoire long-terme** (Turn on long-term memory) switch.
3. Chat normally. When you give lasting information, the assistant notes it.
4. Come back to **Mémoire** to reread, correct or erase what it has remembered.

The page has two parts:

- **Profil utilisateur** (User profile): who you are, your role, your preferences, the way you work.
- **Notes**: facts about your environment, your projects, the decisions made.

### What the assistant remembers, seen from the chat

[The assistant remembers a fact: the Mémorisé line, unfolded, lets you undo it](media/aide/memoire-chat.webm)

Each write to memory leaves a line in the reply: **Mémorisé** (Remembered), followed by **profil utilisateur** or **notes projet** (project notes) and the text kept. Depending on the case, the line also says **Mémoire mise à jour** (Memory updated), **Retiré de la mémoire** (Removed from memory) or **Mémoire réorganisée** (Memory reorganized).

1. Click the line to unfold it: you see exactly what was added or removed.
2. **Annuler** (Undo) undoes that write.
3. **Gérer la mémoire** (Manage memory) opens the **Mémoire** page of the settings.

You can ask for something to be remembered in plain words, for example "Retiens que l'astreinte change le lundi" (Remember that on-call changes on Monday). The assistant also notes by itself what seems lasting to it.

### Reviewing and correcting

[Add an entry to memory with Éditer, then Enregistrer](media/aide/memoire-editer.webm)

Under each entry, a line gives its date and origin: **Paramètres** if you wrote it, or the title of the conversation where the assistant learned it. This title is a link to the conversation, as long as it exists.

1. Click **Éditer** (Edit). Each entry becomes a text field.
2. Correct the text, click **Ajouter** (Add) for a new entry, or the trash can to remove one.
3. Click **Enregistrer** (Save). **Annuler** discards your changes.

**Rafraîchir** (Refresh) rereads the memory, for example after a conversation opened in another window.

### Erasing everything

At the bottom of the page, **Effacer tout** (Erase all) permanently deletes everything the assistant has remembered, after confirmation. This action is irreversible.

Turning off the switch deletes nothing: the assistant only stops reading and writing memory.

### Getting the most out of it

- Write your profile yourself as soon as you turn it on: your job, your level, the tone and format of answer you prefer. The first answers take it into account.
- The counters to the right of each part, for example `133 / 1375`, show the space used. When a part is full, the assistant has to group or remove notes before adding any: the line then shows **Mémoire pleine** (Memory full). Sort it out yourself with **Éditer**.
- Reread the memory from time to time. A wrong or outdated note steers all the following conversations.
- When memory is on, the assistant can also search your past conversations. Ask it "qu'avions-nous décidé sur le format des journaux ?" (what did we decide about the log format?).
- Information to remember for a whole procedure belongs rather in a skill: see [Skills](#skills).
- `/settings memory` opens the same page as `/memory`.

### How it works

The assistant rereads both parts of the memory in all the conversations that follow. Their size is deliberately limited: a memory that grows without end no longer helps. This is what pushes the assistant to group its notes instead of piling them up.

Memory belongs to your account. The administrator can turn it off for the whole application: if the assistant remembers nothing while the switch is on, ask your administrator.

## Prompts
<!-- aide: prompts -->

A saved prompt is a request you reuse: a review instruction, the outline of a report, an email template. You keep it under a title and reinsert it in a few keystrokes. A template goes further: it is a prompt with blanks, for which the application asks you the values.

[Save a prompt from a message, then reinsert it with /prompt](media/aide/prompts-sauvegarder.webm)

### The essentials

1. In a conversation, hover over one of your messages.
2. Click the **Sauvegarder** (Save) bookmark, at the top right of the message.
3. Give a title, then click **Valider** (Confirm).
4. Later, type `/prompt` in the composer, then press `Enter`.
5. Choose the prompt: its text arrives in the input.

A prompt is always **inserted, never sent**: you reread, you complete, then you send.

### Finding a prompt

Three paths lead to your prompts:

- **`/prompt`** lists your prompts and those you have received. Type a few letters to filter on title and content. The chosen prompt replaces what is in the input.
- **The + button of the composer**, then **Prompts** under **Insérer** (Insert). The chosen prompt is added after what you have already written.
- Paramètres (Settings) › **Prompts** shows the full list, with the date saved.

In Paramètres › **Prompts**:

- Click a row to unfold the whole content.
- **Rechercher un titre ou un contenu…** (Search a title or a content...) ignores accents: "resume" finds "résumé".
- Sort by **Plus récents** (Most recent), **Plus anciens** (Oldest) or **Titre A→Z** (Title A to Z).
- When you hover over a row, five buttons appear: **Insérer** sends it to the chat input, **Copier** (Copy) puts it in the clipboard, **En faire un template** (Make it a template) draws a template from it, **Partager** (Share) sends it to other accounts, **Supprimer** (Delete) erases it.

The content is shown as is. A prompt is source text: its Markdown is not interpreted, the `#`, the `**` and the code blocks stay visible, and **Copier** retrieves them intact.

### Sharing a prompt and reading the ones sent to you

To share:

1. In Paramètres › **Prompts**, hover over the prompt and click **Partager**.
2. In the **Transférer** (Transfer) window, tick the recipients. The **Groupe :** (Group:) badges narrow the list to one group; **Sélectionner tous les membres visibles** (Select all visible members) ticks the whole list displayed.
3. Click **Envoyer** (Send).

To read what you receive:

1. A red badge on the composer's **+** button shows the number of shares received.
2. Click **+**, then **Partages reçus** (Received shares). Each share shows its title, its sender and its text.
3. Click a share to insert it into the input.

In this panel, the trash can of a share deletes it, **Sélectionner** (Select) lets you delete several, and **Vider** (Empty) deletes them all.

### Templates

A template is a prompt with blanks, called by a shortcut. The chat calls them **Gabarits**, the settings page **Templates**: they are the same objects.

[Insert a template with /template and fill in its fields](media/aide/prompts-template.webm)

1. Type `/template`, then press `Enter`.
2. Choose a template from the list. If you know its shortcut, type it directly: `/template resume`.
3. If the template contains fields, a window asks for them. Fill them in.
4. Click **Insérer**, or press `Enter`. `Esc` cancels.
5. The full text arrives in the input, without being sent.

The composer's **+** button also gives access to templates, under **Insérer** › **Gabarits**.

#### Creating a template

1. Open Paramètres › **Prompts** › **Templates**, then click **Nouveau** (New).
2. Fill in the **Titre** (Title) and the **Raccourci** (Shortcut). The shortcut accepts only lower-case letters, digits, `-` and `_`, with no space; it is suggested from the title.
3. Write the **Contenu** (Content), with its variables between double curly braces.
4. Check the **Variables** line under the content: it lists the fields recognized.
5. Click **Enregistrer** (Save).

Two shortcuts: **En faire un template**, on the row of a saved prompt, takes over its title and text; the last entry of the `/template` menu, **Nouveau gabarit** (New template), opens the same form.

#### Writing variables

A variable is written `{{name}}`. Its options go **after a vertical bar**, separated by colons.

| In the content | Effect |
|---|---|
| `{{client}}` | Text field. A name repeated is asked for only once |
| `{{notes \| textarea}}` | Multi-line area |
| `{{ton \| select:options=["neutre","formel"]}}` | List of choices |
| `{{client \| placeholder="ex. la direction"}}` | Example shown in the empty field |
| `{{langue \| default="français"}}` | Suggested value, editable |
| `{{client \| required}}` | Required field |
| `{{date}}` `{{heure}}` `{{date_heure}}` `{{jour}}` `{{utilisateur}}` | Filled in automatically |
| `{{presse_papier}}` | Clipboard content. If it cannot be read, a field asks you to paste it |

Options can be combined: `{{notes | textarea:placeholder="Collez vos notes":required}}`. Without the vertical bar, the variable is not recognized and stays written as is in the text.

The English names `{{CURRENT_DATE}}`, `{{USER_NAME}}` and `{{CLIPBOARD}}` are recognized too: a template that uses them works as is.

### Getting the most out of it

- To complete a text already started, go through **+** › **Prompts**: the prompt is added after it. `/prompt` replaces the content of the input.
- Save a message right after a reply that suited you: the bookmark keeps the request as you sent it.
- As soon as part of a prompt changes with each use, make it a template with **En faire un template** and replace that part with a variable.
- Put `{{presse_papier}}` in a review or summary template: copy the text to process, run the template, everything is ready.
- A list of choices avoids typos on values that come back: tone, language, length.
- A prompt says **what** to ask. To teach the assistant **how** to do a task, write a skill instead: see [Skills](#skills).
- `/settings prompts` opens the prompts page from the chat.

## The Studio
<!-- aide: studio -->

The Studio drives the screen of another machine, Windows or Linux, from the application. You see its screen, you act on its buttons and fields, and you turn what you do into scripts you can replay. For example, you can use it to automate an application that only offers a graphical interface.

The Studio needs a **machine cible** (target machine), declared by your administrator. Without one, the page shows "Aucune machine cible configurée" (No target machine configured): ask your administrator.

[Capture the screen of a target machine, then click an element remotely](media/aide/studio.webm)

### The essentials

1. In the sidebar, open **Plus** (More), then **Studio**.
2. Choose the machine in the **Choisir une cible…** (Choose a target…) list, at the top right.
3. Click **Capturer** (Capture). The machine's screen appears; each element that is recognized gets a frame.
4. Click an element. A menu offers the actions: **Clics** (Clicks), then **Cliquer** (Click) sends the click to the machine.
5. The capture refreshes: you see the result.

You can also ask for the action in plain language in the **Assistant** tab, on the right: "ouvre le menu Fichier" (open the File menu), "clique sur Enregistrer" (click Save).

### Simple or Expert

Two buttons at the top of the page set the level of tooling.

- **Simple**: the target, the capture, the assistant and the script. This is the starting level.
- **Expert**: all the tools. The **Inspecter** (Inspect), **Zone** and **Glisser** (Drag) modes, the **Plans** (Layers) and the element **Arbre** (Tree) appear.

### Capturing the screen

- **Capturer** takes an image of the machine and reads its elements. The **LIVE** indicator shows a fresh image.
- The arrow next to **Capturer** opens **Lire (OCR)** (Read (OCR)), which reads the visible text, and **Vider** (Clear), which clears the scene.
- The gear icon opens the capture settings. **Annoter par vision** (Annotate by vision) has the vision model frame the elements; when it is off, the capture comes with the machine's element tree, which is faster. **Quoi annoter ?** (What to annotate?) limits the annotation to what you describe. **Écran capturé / piloté** (Captured / driven screen) chooses the screen when the machine has several.

### Acting on an element

Click a frame: the menu opens on that element. Its name and role are shown at the top.

- **Clics**: **Cliquer**, **Double-cliquer** (Double-click), **Triple-cliquer** (Triple-click), **Clic droit** (Right-click), **Clic milieu** (Middle-click).
- **Contrôle (fiable)** (Control (reliable)): **Cocher** (Check), **Décocher** (Uncheck), **Sélectionner (liste/onglet)** (Select (list/tab)), **Déplier** (Expand), **Replier** (Collapse), **Définir la valeur…** (Set the value…). The action goes through the element itself, not through its coordinates.
- **Saisie** (Input): **Taper…** (Type…), **Coller…** (Paste…), **Copier** (Copy).
- **Touches** (Keys): the usual keyboard shortcuts.
- **Souris** (Mouse): **Survoler (déplacer)** (Hover (move)), **Glisser-déposer depuis ici…** (Drag and drop from here…), scrolling.
- **Lecture** (Reading): **Lire (OCR) la zone** (Read (OCR) the area) and **Demander au modèle…** (Ask the model…).

A right-click elsewhere on the capture opens the same menu for the point you aimed at. Under the capture, a bar shows the chosen element, its parents and the way a script will designate it.

In **Expert**, three modes are added near the title: **Inspecter** to hover and click, **Zone** to draw a rectangle to read or to submit to the model, **Glisser** for a drag and drop. **Plans** shows only some windows. The **Arbre** lists all the elements, with a filter, an **Audit** of the controls that have no name or identifier, and a CSV export.

### Writing an automation

The **Script** tab turns your gestures into a Python script that you can replay on the machine.

1. Open the **Script** tab and give a **Nom du script** (Script name).
2. Click **Enregistrer** (Record), to the left of the name: the button changes to **REC**. Each action you perform on the capture is written into the code, at the cursor.
3. Complete it with blocks: in the **Script** tab, an element's menu gains a **Script** entry (**Si présent…** (If present…), **Si absent…** (If absent…), **Répéter** (Repeat), **Attendre l'élément** (Wait for the element), **Vérifier présent** (Check present), **Lire sa valeur (variable)** (Read its value (variable)), **Note…**).
4. Click the second **Enregistrer** (Save), marked with a floppy disk: the script is stored in your sandbox, in the `automations` folder.
5. Click **Exécuter** (Run) to launch it on the target machine. A report lists each step.

The arrow next to **Exécuter** offers three other modes:

- **Essai sans action** (Dry run): the script looks for each element on the machine, without clicking or typing anything.
- **Exécuter avec trace** (Run with trace): a capture at each step, to review in the report.
- **Sur plusieurs machines** (On several machines): tick the targets, then **Lancer la matrice** (Launch the matrix).

The script can be downloaded alone, or with what it needs to run outside the application.

### Getting the most out of it

- **Composer par l'IA** (Compose with AI), in the **Assistant** tab: describe the goal. The assistant acts step by step and each successful action becomes a line of the script.
- Prefer **Contrôle (fiable)** to clicks when the element allows it: the script finds a checkbox or a list again even if the window has moved. In the script, a gesture by coordinates is the most fragile.
- Always run an **Essai sans action** before a real run: it reveals the elements that cannot be found without touching the machine.
- Leave **Annoter par vision** off as long as the target application exposes its elements: the capture is faster. Turn it on for an application that exposes none.
- In **Quoi annoter ?**, press `Enter` to capture right away with your description.
- When a step fails, the report shows its capture. You can ask the model for a replacement line from the report.
- The script bar has a cheat sheet of the available instructions and a button to copy the code.
- In **Expert**, run the tree's **Audit** before automating an application: it lists the buttons with no name or identifier, the ones a script will have trouble finding again.

### How it works

A small control program runs on the target machine. It sends captures and the list of the elements on the screen, and carries out the gestures that you or the assistant ask for. The machines you can drive are chosen by your administrator.

A script designates its elements by their identifier, failing that by their name and role, and as a last resort by their coordinates. The more precise the designation, the better the script withstands changes on the screen.

## Notifications
<!-- aide: notifications -->

The bell, at the bottom of the sidebar, tells you what finished without you: a routine, the indexing of your documents, a collection shared with you.

[A routine finishes: the message, the bell badge, then the routine opened from its notification](media/aide/notifications.webm)

### The essentials

1. When a notification arrives, a message appears at the bottom right and a red badge on the bell counts the unread notifications.
2. Click the bell. The list opens, sorted by date: **Aujourd'hui** (Today), **Hier** (Yesterday), **Cette semaine** (This week), **Plus ancien** (Older).
3. Click a notification to go to its source. The one for a routine opens the [Routines](#routines) page on that routine and its log.

Opening the list marks everything as read: the badge disappears.

### What you receive

- The end of a [routine](#routines), successful or failed, depending on that routine's **Notifications** setting.
- The end of the indexing of a [documents](#your-documents-rag) collection, a collection shared with you, a collection that is no longer available.
- For administrators and moderators, the daily usage report.

The answer of a conversation that you left while it was being written is announced differently: a "réponse prête" (answer ready) message with an **Ouvrir** (Open) button. It is not kept in the bell.

### Managing the list

- When you hover over a notification, two buttons appear: **Marquer comme non lu** (Mark as unread) (or **Marquer comme lu** (Mark as read)) and **Supprimer** (Delete).
- **Tout lu** (All read) marks the whole list as read.
- **Effacer** (Clear) empties the list. A message offers **Annuler** (Undo) for a few seconds.
- **Voir plus** (See more), at the bottom of a long list, loads older notifications.

### Getting the most out of it

- The **Voir** (View) button of the arrival message leads straight to the source, without going through the bell.
- A frequent routine can flood the list. In its **Général** (General) tab, **Historique** (History) block, set **Notifications** to **Échecs seulement** (Failures only) or **Aucune** (None), and limit **Notifications gardées** (Notifications kept).
- To be warned outside the application, turn on **Notifications système** (System notifications) in Paramètres (Settings) › **Chat** › **Conversation**. Your system then shows a notification (end of a routine, report) when the window is not in the foreground. The setting applies to this browser only, which asks for your permission the first time. If the switch is greyed out, your browser or the connection does not allow it: ask your administrator.
- When the application's tab is in the background, its title shows the number of unread notifications in parentheses.

# Configuration

## Settings
<!-- aide: parametres -->

The **Paramètres** (Settings) gather your account's settings: profile, appearance, chat behavior, active features, access. They apply to you only. Most are saved as soon as you change them.

[Open the Settings and find a setting with the search](media/aide/parametres-recherche.webm)

### The essentials

1. Click the **Paramètres** gear icon at the bottom of the sidebar.
2. Choose a tab in the left rail. The fuller tabs are divided into parts, in a strip at the top of the content.
3. Change the setting. The **Enregistré** (Saved) message confirms the write; its **Annuler** (Undo) button restores the previous value.
4. Close with the cross or with `Esc`.

Forms have their own button: the password (**Mettre à jour** (Update)), the memory (**Enregistrer** (Save)), a secret (**Créer** (Create)), a Git account (**Ajouter** (Add)).

### Finding a setting

The **Rechercher** (Search) field is at the top of the rail.

1. Type a word: `sombre` (dark), `quota`, `jeton` (token), `mot de passe` (password).
2. The rail keeps only the tabs that match.
3. Click the tab: it opens on the right part.

The search ignores accents and knows the former names of the tabs. If nothing matches, the rail shows **Aucun réglage trouvé.** (No setting found.)

### The tabs

The rail arranges the tabs in four groups; each tab is detailed in the section indicated.

- **Général** (General): **Profil** (Profile) (photo and password, see below); **Apparence** (Appearance) (see [Appearance](#appearance)); **Chat**, with three parts: **Conversation** (**Prompt système** (System prompt), **Largeur** (Width) of the thread, **Terminal en direct** (Live terminal), wake-up of background tasks, **Notifications système** (System notifications), **Effacer les conversations** (Clear conversations)), **Affichage** (Display) and **Voix** (Voice); **Fonctionnalités** (Features), with **Modules**, **Images** and **Éditeur** (Editor).
- **Assistant**: **Modèles IA** (AI models), **Prompts**, **Skills** and **Mémoire** (Memory). See [Models and providers](#models-and-providers), [Prompts](#prompts), [Skills](#skills) and [Memory](#memory).
- **Accès** (Access): **Secrets**, with **Secrets web** (Web secrets), **Comptes Git** (Git accounts) and **Jetons MCP** (MCP tokens). See [Secrets and Git accounts](#secrets-and-git-accounts).
- **Avancé** (Advanced), collapsed: click it to see **Compaction** (see [The conversation context](#the-conversation-context)), **Sandbox** (see [The sandbox and the code editor](#the-sandbox-and-the-code-editor)), **Archives** (see [Conversations](#conversations)) and **Utilisation** (Usage).

Paramètres › **Fonctionnalités** › **Modules** turns on or off **MCP** (all the assistant's tools), **Images**, **Sandbox** (the code panel) and **Créer des routines** (Create routines) (the assistant can save a routine, always paused, after your approval). The **Images** and **Éditeur** parts only appear if the feature is available and active.

Paramètres › **Avancé** › **Utilisation** shows your tokens, conversations, messages and routine runs over 1, 7, 30 or 90 days. This data is aggregated locally and never sent outside.

Subagents have no tab: they are set in the **Agents** page of the **Plus** (More) menu (see [Subagents](#subagents)). Your MCP servers are managed in the [MCP panel](#tools-and-the-mcp-panel).

### Profile and password

#### Changing your photo

[Change your profile photo: choose the image, crop it, confirm](media/aide/parametres-profil.webm)

1. In **Profil**, click **Photo** and choose an image.
2. The **Recadrer la photo de profil** (Crop the profile photo) window opens. Drag the image to move it. Zoom with the wheel, the slider, or with `+` and `-`.
3. **Remplir** (Fill) covers the whole frame, **Ajuster** (Fit) shows the whole image. The two arrows rotate it a quarter turn.
4. Click **Valider** (Confirm). **Annuler** (Cancel) or `Esc` closes without sending anything.

The photo replaces your initials in the profile and at the bottom of the sidebar. The trash can next to **Photo** removes it.

#### Changing your password

1. In **Profil**, click **Mot de passe** (Password).
2. Enter the **Mot de passe actuel** (Current password), the **Nouveau mot de passe** (New password) and the **Confirmation**.
3. Click **Mettre à jour**. The button stays off as long as the two entries differ.

Your administrator can require a minimum length and certain characters. If you have forgotten your password, ask them to reset it.

### Getting the most out of it

- Type `/settings` in the chat composer to open the Settings without leaving the keyboard. Add a space: the list offers the tabs and the parts, for example **Comptes Git** or **Apparence**.
- A change made by mistake can be undone right away: click **Annuler** in the **Enregistré** message.
- The window reopens on the last part you viewed in each tab.
- The search understands the intent, not only the label: `photo` leads to **Profil**, `consommation` (consumption) to **Utilisation**, `git` to **Secrets**.
- The **Prompt système** and the generation settings apply to all your conversations. What the **Conversation** part sets is described with each feature: [When the assistant acts](#when-the-assistant-acts) for **Terminal en direct** and the wake-up of background tasks, [Notifications](#notifications) for **Notifications système**.

## Appearance
<!-- aide: apparence -->

Appearance is set per account: light or dark mode, skin, animations, presentation of the conversation thread. Everything changes instantly, without reloading the page.

### The essentials

1. Open [Settings](#settings) › **Apparence** (Appearance) › **Thème** (Theme).
2. Choose the **Mode**: **Système** (System), **Clair** (Light) or **Sombre** (Dark).
3. Choose a **Habillage** (Skin) in the list.

Each choice is saved at once. The **Enregistré** (Saved) message offers **Annuler** (Undo) to go back.

### Light, dark or system mode

[Switch from light to dark mode](media/aide/apparence-sombre.webm)

- **Clair** and **Sombre** set the mode.
- **Système** follows your workstation's preference: if it switches to dark in the evening, the application follows.

The mode applies to the chat, the sidebar and the windows. The code editor has its own theme (see below).

### Skins

[Change skin: the whole application follows at once](media/aide/apparence-skin.webm)

A skin changes the colors, the fonts and sometimes the layout: **Alizé** is light and very airy, **Veilleuse** is designed for the evening, **Terminal** shows everything in a fixed-width font.

1. In Settings › **Apparence** › **Thème**, open the **Habillage** list.
2. Choose a name: the application changes right away. A line under the list describes the skin.
3. If the skin offers several palettes, a **Couleurs** (Colors) list appears. The Elpis skin offers **Or** (Gold) and **Argile** (Clay).

The list shows the skins that your administrator has enabled, then your own. The name and image of the assistant are those of the application: they are chosen by the administrator.

#### My skins

You can have your own skins, visible to you alone (10 at most by default).

1. Under the list, click **Créer avec l'assistant** (Create with the assistant).
2. Describe the mood, the colors and the light or dark base. The assistant asks a few questions, then answers with a skin block.
3. A card appears under the block and checks it by itself: **Valide** (Valid), or the number of problems (insufficient contrast, for example).
4. **Prévisualiser** (Preview) shows a mock-up in light and dark. **Importer** (Import) adds the skin to your list, **Importer et appliquer** (Import and apply) also activates it.

The import is always your click, never the assistant's. It stays off as long as there are problems: **Demander une correction** (Ask for a fix) sends them back to the assistant. If the name already exists, the application offers to replace it. In **Mes habillages** (My skins), **Aperçu** (Preview) reopens the mock-up and **Supprimer** (Delete) removes the skin after confirmation. This part is absent if your administrator has turned the feature off.

### Animations

The **Animations** row, under **Mode**, sets the motion of panels and menus.

- **Système** follows your workstation's "reduce animations" setting.
- **Complètes** (Full): panels and menus slide, even if the workstation asks for less motion.
- **Réduites** (Reduced): short fades, with no movement.

### Display of the conversation thread

These settings are in Settings › **Chat** › **Affichage** (Display).

- **Déroulé** (Flow): the way the assistant's work is shown. **Classique** (Classic) (the default) folds the work into one line and leaves the answer in plain view. **En bloc** (In a block) groups it above the answer, open during the turn. **Chronologie** (Timeline) shows reasoning, text and steps in order. **Journal** (Log) writes one line per action, terminal style.
- **Contexte** (Context): the shape of the context gauge. **Jetons (utilisés / fenêtre)** (Tokens (used / window)), **Bloc qui se remplit** (Filling block), **Pourcentage** (Percentage) or **Anneau** (Ring). See [The conversation context](#the-conversation-context).
- **Réflexions** (Reasoning): **Repliées** (Collapsed) (the default), **Dépliées** (Expanded) or **Masquées** (Hidden).
- **Métriques** (Metrics): the figures under each answer. **Complètes** (Full), **Essentielles (modèle, durée)** (Essentials (model, duration)) or **Masquées**.
- **Densité** (Density): **Confortable** (Comfortable) or **Compacte** (Compact).
- **Captures d'étape du navigateur** (Browser step captures): a capture after each action of the assistant in its browser. Off by default; the captures that the assistant requests itself are always shown.

The thread's **Largeur** (Width) is set in Settings › **Chat** › **Conversation**. The llama.cpp skin imposes its own width.

### Editor and mascot

The **Apparence** tab has two other parts.

- **Éditeur** (Editor): **Selon le skin** (According to the skin) (the default) gives the code editor the skin's style, **Classique** keeps the original editor; a skin with no editor style keeps the classic editor. **Thème sombre** (Dark theme) applies to the editor alone, independently of the page's mode.
- **Mascotte** (Mascot): **Accueil d'un nouveau chat** (New chat welcome) chooses what is shown above the composer. **Logo** keeps the logo; a character from the list animates it. Untick **Animer l'accueil** (Animate the welcome) for a still image. A skin that brings its own mascot shows it as long as you have not turned it off. This part is absent if your administrator has removed the mascots.

### Getting the most out of it

- Leave the **Mode** on **Système** if your workstation changes theme according to the time: the application follows with no setting on your part.
- On a small screen, combine **Densité** **Compacte** and **Métriques** **Essentielles (modèle, durée)**: more messages fit on the screen.
- To follow a long line of reasoning, set **Réflexions** to **Dépliées** or **Déroulé** to **Chronologie**. To keep only the answers, choose **Masquées**.
- If your workstation reduces animations but you like to see panels slide, choose **Complètes**: the setting applies only to the application.
- You can work in light mode with a dark editor: turn on **Thème sombre** in Settings › **Apparence** › **Éditeur**.
- Trying costs nothing: change skin, look, then click **Annuler** in the **Enregistré** message to get the previous one back.
- Type `/settings` in the composer and choose **Apparence** to arrive here from the chat.

## Secrets and Git accounts
<!-- aide: secrets -->

A secret is a login, a password or a token that you entrust to the application so that the assistant can use it on your behalf: log in to a site, clone a private repository. The assistant never sees its value. Everything is managed in [Settings](#settings) › **Secrets**.

### The essentials

1. Open Settings › **Secrets**.
2. Choose the part: **Secrets web** (Web secrets) for your sites, **Comptes Git** (Git accounts) for your repositories.
3. Create the secret or the account. The value is encrypted as soon as it is sent and will never be shown again.
4. For a site, attach the secret to the conversation with `/secret`, then ask the assistant to log in to it.

The tab has three parts:

- **Secrets web**: the logins and tokens that the assistant uses on your sites.
- **Comptes Git**: your access to Git servers, to clone, push and open PRs.
- **Jetons MCP** (MCP tokens): tokens to use your tools from another application. See [Using your tools from another application](#tools-and-the-mcp-panel).

The keys of your model providers and of your MCP servers are managed elsewhere: see [Models and providers](#models-and-providers) and the [MCP panel](#tools-and-the-mcp-panel).

### Adding a web secret

[Create a secret: name, site, login and value](media/aide/secrets-ajouter.webm)

1. In **Secrets web**, click **Nouveau secret** (New secret).
2. **Nom** (Name): a short name in lower case, digits, dots and hyphens, for example `intranet-rh`. This is the one you will type in the chat.
3. **Type**: **web-login** for a site that you log in to through a form, **http-auth** for a site that opens the browser's authentication window, **token** for a token alone, with no site.
4. **Sites**: the address of the site, for example `https://rh.exemple.fr`. **Ajouter un site** (Add a site) adds more, ten at most. The secret will only be used on these sites.
5. **Identifiant** (Login) and **Valeur** (Value): your login name and the password. The value is hidden as you type.
6. Click **Créer** (Create).

The secret joins the list with its type, its version, its login, its last use and its sites. Three buttons follow it:

- rotation replaces the value and moves to the next version;
- **Modifier** (Edit) changes the name, the sites, the login or the options;
- **Supprimer** (Delete) asks for a second click on the same button.

Two settings deserve a look. **TLS**: **strict** requires a valid certificate; **insecure** accepts an unverified certificate, to be kept for an internal site. **politique** (policy): **sous-agents** (subagents) lets the conversation's subagents use the secret (ticked by default), **routines** lets your routines use it (unticked by default).

### Attaching a secret to a conversation

[Attach a secret to the conversation with /secret](media/aide/secrets-conversation.webm)

The assistant only uses a secret in the conversations where you have attached it.

1. In the composer, type `/secret` then a space.
2. Choose **attach**, then the secret in the **Secrets à attacher** (Secrets to attach) list.
3. A `secret:intranet-rh` chip appears above the composer.
4. Ask for your task: "Connecte-toi à l'intranet RH et relève mon solde de congés" (Log in to the HR intranet and read my leave balance).

The assistant opens the site in its browser and logs in with the secret, without knowing the value.

- To detach, click the cross on the chip, or type `/secret detach` followed by the name. `/secret detach --all` detaches everything.
- `/secret` alone lists the attached secrets and the available ones.
- Only the **web-login** and **http-auth** types can be attached, ten at most per conversation.

### Git accounts

[Add a Git account: URL, scope, token](media/aide/secrets-git.webm)

A Git account gives access to your repositories on GitHub, GitLab, Bitbucket, Gitea or Forgejo, or on any other Git server.

1. In **Comptes Git**, click **Ajouter un compte** (Add an account).
2. **URL**: paste the address of your Git server, of an organization or of a repository. The **Type de serveur** (Server type) is recognized when you leave the field; correct it if needed.
3. **Utiliser ce compte pour** (Use this account for): choose where the account applies. The URL offers the levels it contains: the whole server (`gitlab.exemple.fr`), an organization (`gitlab.exemple.fr/atelier`) or a single repository.
4. Enter your **Identifiant** (Login) if the server asks for one, then the token created on your Git server.
5. **Nom du compte (facultatif)** (Account name (optional)) helps tell two accounts apart: `perso`, `robot`.
6. Click **Ajouter** (Add), then **Tester** (Test) to check the token.

These accounts are used by the editor's Git panel and by the assistant's Git tools: cloning on a private server works without you typing any credentials. See [The sandbox and the code editor](#the-sandbox-and-the-code-editor).

What you need to know:

- Several accounts can share a server. For a repository, the most specific account is the one used: a personal token for the whole server and a token limited to one organization coexist. Two accounts cannot apply to exactly the same place.
- When editing an account, leave the token empty to keep the current one. Narrowing what the account applies to keeps the token; widening it, or changing the server or the type, asks for it again.
- The case of the path is ignored, except for the **Autre serveur Git** (Other Git server) type. On Bitbucket Server, paste the clone address: its path starts with `scm/`.
- An account marked **inactif** (inactive) is used for no repository: edit it to choose what it applies to.
- An account marked **à vérifier** (to check) carries a token taken over from an old file in your sandbox. It is not used until you have checked it in **Secrets web**, or entered it again here.
- The assistant cannot receive a token in the chat. When a repository asks for one, it invites you to add the account here.
- Your administrator may limit the Git servers your sandbox reaches. A Git account on another server is then refused: ask your administrator. When only your own Git accounts are allowed, a repository that none of them covers is refused until you add one.

### Getting the most out of it

- Paste the full address of a page into **Sites**: it is reduced by itself to the site's address.
- When a password changes, use rotation rather than recreating the secret: its name and its conversations stay.
- Hover over a secret's name: the tooltip summarizes the login, the TLS setting, the version, the number of uses and the last one.
- `/secret attach` accepts several names in a row. The list completes as you type.
- On a new chat, attach the secret before writing: it goes with your first message.
- Tick **routines** on the secrets that a scheduled routine must use without you.
- Type `/settings` in the composer and choose **Comptes Git** to open this part directly.
- Give a broad token to your personal account and a token limited to the sensitive organization: the most specific one wins, with nothing to choose at each repository.

### How it works

The values are encrypted in a vault, on the application's server. They are never written in your sandbox, never sent back to your browser, never passed to the assistant.

The assistant only knows an attached secret's name, type, sites and login. At the moment of logging in, it is the application that enters the value, and only toward the secret's sites. A booby-trapped page or a malicious document therefore cannot make the assistant say a password it does not have.

## Models and providers
<!-- aide: modeles -->

The model is the engine that writes the answers. Depending on your installation, you can choose between several models: a fast one for everyday questions, a more powerful one for hard tasks. The name of the model in use is shown in the composer.

[Open the model list and pick another one](media/aide/chat-modele.webm)

### The essentials

1. Click the model name in the composer, to the left of the send button.
2. Click the model you want. The list closes and its name replaces the old one.
3. Send your message: that model answers.

The choice applies to your next messages, in all your conversations, and your browser remembers it. Answers already written do not change: the line under each one shows the model that produced it.

### Reading the model list

Models are grouped by server. **Serveur intégré** (Built-in server) is the engine installed with the application; then come the other servers and the providers, added by the administrator or by you.

- **The server status**, to the right of its name: **En ligne** (Online), or **Injoignable** (Unreachable) with a **Réessayer** (Retry) link.
- **The check mark** marks the model in use.
- **The badges** under the name say what the model can do: **Réflexion** (Reasoning) (it reasons before answering), **Vision** (it reads images), and the size of its working memory, for example **32 k**. The larger it is, the longer the conversation can be: for a long document, prefer a model with a large memory. **Réflexion** only shows on the model in use.
- **The model status**: **Chargé** (Loaded) (ready to answer), **Disponible** (Available) (not loaded yet: its first answer will take longer), **Chargement…** (Loading…), or **Échec** (Failed).
- **The three dots** at the end of the row open the model's actions: **Fiche du modèle** (Model card) for its characteristics, and, if the server allows it, **Charger** (Load) or **Décharger** (Unload).

At the bottom of the list, **Rafraîchir la liste** (Refresh the list) rereads the available models. When the server provides it, a gauge there also shows the working memory used.

### Setting the reasoning effort

[Choose the reasoning effort in the model menu](media/aide/chat-effort.webm)

A model that reasons gives better answers to hard questions, but takes longer. You set the dosage:

1. Open the model list.
2. Click **Réflexion**, under the list.
3. Choose a level in **Effort de réflexion** (Reasoning effort): **Auto**, **Basse** (Low), **Moyenne** (Medium), **Élevée** (High).

The chosen level is shown to the right of **Réflexion**. The levels offered are the ones the model accepts: some models offer others (**Aucune** (None), **Minimale** (Minimal), **Très élevée** (Very high), **Maximale** (Maximum)), and the **Réflexion** row does not exist for a model that does not adjust its effort. **Auto** lets the model decide.

During the answer, you follow the reasoning and you can cut it short with **Répondre maintenant** (Answer now). See [The chat](#the-chat).

### Adding your own providers

If the administrator allows it, you can use the models of an external provider (Anthropic, OpenAI and others) with your own key.

1. Open Paramètres (Settings) › **Modèles IA** (AI models).
2. Under **Mes fournisseurs** (My providers), click **Ajouter** (Add).
3. Choose the **Fournisseur** (Provider) and paste your **Clé API** (API key). **Modèle par défaut** (Default model) and **Nom** (Name) are optional.
4. Click **Ajouter**, then **Tester la connexion** (Test the connection): the number of models found is shown.
5. The provider's models appear in the composer's list, in their own group.

What you need to know:

- Your key is encrypted, and it is never shown again. To change it, edit the provider and enter the new one.
- **Fournis par l'administrateur** (Provided by the administrator) lists the servers made available to everyone. You have nothing to set there.
- With an external provider, your messages leave your organization's network and are billed to your account with that provider. The **Gratuit** (Free) badge flags a model with no billing.
- A model belongs to a provider: by choosing the model, you also choose the server that answers. It is not possible to send a request to the wrong provider by mistake.

### What the administrator decides

- **The models offered** and the servers that run them.
- **The servers open to your account.** If the list says **Aucun serveur autorisé** (No server allowed), your account has no access to any model and sending is blocked: ask your administrator.
- **The external providers open to accounts.** By default, none is. The **Modèles IA** page says so: "Aucun fournisseur cloud n'est ouvert aux comptes par l'administrateur" (No cloud provider is open to accounts by the administrator). A provider that the administrator closes stays registered with you, marked **fermé par l'administrateur** (closed by the administrator), but can no longer be used.
- **The right to load and unload** a model.

### Generation settings

The **Génération** (Generation) panel sets how the model writes: its temperature, the length of its answers, its reasoning, the number of tool turns. Without any setting from you, each model keeps its own values.

[Open the generation settings from the model menu and change the temperature](media/aide/generation-reglages.webm)

1. In the composer, click the model name.
2. At the bottom of the menu, click **Paramètres de génération…** (Generation settings…). The panel opens on the right.
3. Enter a value in the field to change. An empty field keeps the model's value, shown greyed out.
4. Close the panel: the setting is already saved.

Your settings are saved on your account: they apply to all your conversations, not only the one that is open.

The panel contains:

- **Contexte** (Context): a gauge of the space used in the model's window. **Régler** (Adjust) opens the compaction threshold, in Paramètres (Settings) › **Avancé** (Advanced) › **Compaction** (see [The conversation context](#the-conversation-context)).
- **Sortie** (Output): **Température** (Temperature) (the higher it is, the more varied the answers) and **Longueur** (Length). **Auto** lets the application choose according to the space available; **Limiter** (Limit) sets a maximum in tokens.
- **Réflexion** (Reasoning), if the model can reason: the **Réflexion** switch, the **Effort**, the **Budget** in tokens and **Raisonnement conservé** (Reasoning kept).
- **Outils** (Tools): **Tours d'outils** (Tool turns), the number of calls to the model within a single answer when it uses tools.
- **Avancé**: **Top P**, **Top K**, **Min P** and **Pénalité de répétition** (Repetition penalty).

Good to know:

- A modified setting is marked with a dot. The arrow next to the field, **Revenir à…** (Revert to…), gives that one setting back the model's value.
- The bottom of the panel counts the modified settings ("1 modifié" (1 modified)). **Rétablir le modèle** (Restore the model) cancels them all.
- In the model menu, the **Paramètres de génération…** row shows this number, without opening the panel.
- A setting that the chosen model's engine does not apply carries the note "Non appliqué par…" (Not applied by…): it is ignored when sending.
- When a long task stops on "Budget de tours atteint" (Turn budget reached), **Reprendre** (Resume), in the banner, restarts it; increase **Tours d'outils** for the rest.
- This panel and the [MCP](#tools-and-the-mcp-panel) panel take the same place: opening one closes the other.

### Getting the most out of it

- **Match the model to the task.** A light model to rephrase or summarize, a model that reasons to analyze, plan or write code.
- **Raise the effort for a hard question, lower it for a simple task.** **Élevée** improves long chains of reasoning; **Basse** makes answers faster.
- **Ask for a second opinion.** Change the model, then click **Régénérer la réponse** (Regenerate the answer) under the last answer: the same question is put to the new model.
- **Many models?** Beyond six, a **Chercher un modèle** (Search for a model) field appears at the top of the list. It searches the model name and the server name.
- **Everything works from the keyboard.** In the list, `↑` and `↓` move from one model to another, `Enter` chooses, `→` opens the model's actions or the **Réflexion** menu, `Esc` closes.
- **A model that is Disponible but not Chargé** will answer after a loading time. If you have the right, **Charger** prepares it while you write.

### How it works

A model has to be loaded in memory on its server before it answers: the first message sent to a **Disponible** model is therefore slower than the following ones. Loading and unloading weigh on the server that everyone shares, which is why this right can be reserved.

The size of the working memory is counted in tokens, pieces of words. "32 k" means about 32,000 tokens, for the whole conversation: your messages, the answers, the attached files and the tool results.

# Help

## Keyboard shortcuts
<!-- aide: raccourcis -->

The whole application can be driven from the keyboard. This page gathers the useful keys, screen by screen. On macOS, replace `Ctrl` with `Cmd`.

### The essentials

These keys work everywhere in the application.

| Key | Effect |
|---|---|
| `Ctrl+Shift+O` | New chat, as long as no window is open. In the code editor, this combination opens **Aller au symbole** (Go to symbol) |
| `Esc` | Closes, in order: a confirmation request, a menu, a window, a panel, then the open page |
| `Esc` | Also stops dictation and reading aloud |
| `Tab`, `Shift+Tab` | Moves to the next or previous element. In a window, the tab order stays inside the window |

### In the composer

| Key | Effect |
|---|---|
| `Enter` | Send. During an answer, `Enter` inserts a line break: send once the answer is finished |
| `Shift+Enter` | Insert a line break |
| `/` at the start of the input | Open the command menu |
| `@` | Choose a file from the sandbox |
| `Alt+I` | Switch to Images mode, on the chat screen, if image generation is available |
| `↑` `↓` | Move through the `/` command menu or the `@` file list |
| `Enter` | Confirm the chosen line |
| `Tab` | Confirm the chosen command (`/` menu) |
| `Esc` | Close the menu without clearing the input |

### In the conversation

| Key | Effect |
|---|---|
| `Ctrl+Enter` | Send the message you are correcting |
| `Esc` | Cancel the correction |
| Double-click on the title | Rename the conversation; `Enter` confirms, `Esc` cancels |
| `F2` | Rename, when the **Conversation** menu is open |
| `Enter` | In the conversation search: next result |
| `Shift+Enter` | In the conversation search: previous result |
| `←` `→` | In the image viewer: previous or next image |

### In the menus

These keys apply to all the menus: **+**, **Plus** (More), the account menu, the **Conversation** menu, the model list.

| Key | Effect |
|---|---|
| `↑` `↓` | Previous or next row |
| `Home`, `End` | First or last row |
| `Enter` or `Space` | Choose |
| `→` | Open a submenu: **Skills**, **Prompts**, **Gabarits** (Templates), **Réflexion** (Reasoning), a model's actions |
| `←` or `Esc` | Close the submenu |

### In the help

| Key | Effect |
|---|---|
| `Enter` | In **Rechercher dans l'aide** (Search the help): opens the first section found |
| `Esc` | Closes the help |

### In the code editor

`Ctrl+/` shows this list in the editor itself, when the cursor is not in the code.

#### Moving around

| Key | Effect |
|---|---|
| `Ctrl+P` | Open a file by its name, most recent first |
| `Ctrl+Shift+F` | Search in the content of files |
| `Alt+L` | Show the open file in the tree |
| `Alt+←`, `Alt+→` | Previous position, next position (except on macOS) |
| `Ctrl+G` | Go to a line |
| `Ctrl+Shift+O` | Go to a symbol in the file |
| `F12` | Go to the definition |

#### Writing

| Key | Effect |
|---|---|
| `Ctrl+S` | Save the file |
| `Ctrl+Alt+S` | Save all |
| `Shift+Alt+F` | Format the document |
| `Alt+\` | Ask the assistant for a completion |
| `Ctrl+F` | Search in the file |
| `Ctrl+H` | Search and replace |
| `Ctrl+D` | Select the next occurrence (multiple cursors) |
| `Alt+Click` | Add a cursor |
| `Ctrl+/` | Comment or uncomment the line, when the cursor is in the code |

#### Tabs, panels and the file tree

| Key | Effect |
|---|---|
| `Alt+W` | Close the tab |
| `Alt+PageDown`, `Alt+PageUp` | Next tab, previous tab |
| `Ctrl+Shift+T` | Reopen the last closed tab |
| Middle click | Close the tab |
| `Ctrl+B` | Show or hide the file tree |
| ``Ctrl+` `` | Show or hide the terminal |
| `Ctrl+Shift+P` | The editor's command palette |
| `↑` `↓` | In the tree: previous or next row |
| `→` `←` | In the tree: open or close the folder |
| `Ctrl+Click`, `Shift+Click` | In the tree: add to the selection, select a range |
| `F2`, `Delete` | In the tree: rename, delete |

See [The sandbox and the code editor](#the-sandbox-and-the-code-editor) and [The terminal](#the-terminal).

### In the administration console

| Key | Effect |
|---|---|
| `Ctrl+K` | Search for a page, a setting or an action |
| `Ctrl+S` | Save the changes on the screen |

### Getting the most out of it

- **Hover over a button**: its name appears, with its shortcut when it has one. This is the quickest way to learn new ones.
- **Commands replace many clicks.** `/settings`, `/help`, `/usage`, `/memory` open their screen without leaving the keyboard. The full list is in [The chat](#the-chat).
- **The + menu recalls the command** of each feature, to the right of its name: `/skills`, `/prompt`, `/template`, `/plan`, `/compact`.
- **Pressing `Esc` several times in a row** takes you back to the chat from anywhere, closing only what is open.
- **In the editor, tabs close with `Alt+W`**, not with `Ctrl+W`: the latter closes the browser tab.
- **During an answer, write what comes next**: `Enter` inserts a line break while the assistant is writing; send when it has finished.

### How it works

Browsers keep many combinations for themselves: `Ctrl+N`, `Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`. A web page cannot take them over. The application therefore only uses combinations that work in all browsers, which explains `Ctrl+Shift+O` for a new chat and the `Alt` key for the editor's tabs.

## Frequently asked questions
<!-- aide: faq -->

The questions that come up most often, with a short answer and a pointer to the section that gives the detail. If something is not working, see [Troubleshooting](#troubleshooting) instead.

### The essentials

#### Does my data leave my network?

No, not by default. The model, your files and your conversations stay on your organization's server. There are three exceptions, all explicitly opened:

- an **external model provider**, added by the administrator or by you with your key: your messages are then sent to it;
- a **browsing tool** that the assistant uses to visit a site: it is the server that visits the site, not your workstation;
- a **network access** granted to your sandbox by the administrator.

#### The assistant is wrong or makes things up. What can I do?

1. **Give it the source.** Attach the file with **+**, or mention it with `@`: it reads it instead of guessing its content. See [The chat](#the-chat).
2. **Query your documents.** If the question is about internal documents, turn on a collection with `/rag use`. See [Your documents (RAG)](#your-documents-rag).
3. **Let it check.** With tools turned on, it can read a file or run a command instead of guessing. See [Tools and the MCP panel](#tools-and-the-mcp-panel).
4. **Make it reason more.** In the model menu, set **Réflexion** (Reasoning) to **Élevée** (High). See [Models and providers](#models-and-providers).
5. **Correct the question** with **Éditer et renvoyer** (Edit and resend) rather than adding a message: a wrong answer left in the thread influences the following ones.

#### I reloaded the page during an answer. Is it lost?

No. The answer keeps being written on the server, and the page catches up with it when it reopens. You can also write what comes next while it is being written: see [The chat](#the-chat).

### Models and answers

#### Can I change model during a conversation?

Yes: the model chosen in the composer answers from your next message. See [Models and providers](#models-and-providers), which also explains why the first answer of a **Disponible** (Available) model is slower.

#### The Continuer button does not appear, or the reasoning of an old answer has disappeared

After a stop during reasoning, there is nothing to continue: click **Régénérer la réponse** (Regenerate the answer). The reasoning itself is not saved with the conversation. See [The chat](#the-chat).

#### Are my settings kept?

- **The reasoning effort and the generation settings** are saved with your account: you find them on another workstation.
- **The chosen model** is remembered by your browser: on another workstation, choose it again.
- **The system prompt** (Paramètres (Settings) › **Chat** › **Conversation**) is permanent and applies to all your conversations.

#### How do I know what I am consuming?

Under each answer, a line shows the duration, the speed, the reasoning tokens and the share reread from the cache. Leave the pointer on it for the detail of input and output. For an overview over 1, 7, 30 or 90 days, open Paramètres › **Avancé** (Advanced) › **Utilisation** (Usage), or type `/usage`.

### Conversations and tools

#### A conversation has disappeared

Beyond the number of conversations set by the administrator, the oldest ones are deleted: archive the ones you want to keep. See [Conversations](#conversations).

#### A tool failed. Is it a bug?

Not necessarily. A tool's error message explains how to correct it, and the assistant reads it: it often retries by itself with the right parameter. Expand the step in the thread to see what happened. See [When the assistant acts](#when-the-assistant-acts).

#### A command or a sidebar entry is missing

First check Paramètres › **Fonctionnalités** (Features) › **Modules**: **MCP**, **Images** and **Sandbox** can be turned off there. The other features depend on your installation and your rights: image generation, documents (RAG), subagents, voice. An entry that is still missing has not been opened for your account: ask your administrator.

### Voice

#### I do not see the microphone button

Three possible reasons, in this order: the voice engine is not installed (ask your administrator); **Dictée** (Dictation) is unticked in Paramètres › **Chat** › **Voix** (Voice); or the page is not served over a secure connection (HTTPS), which browsers require for the microphone.

#### The dictation writes sentences I did not say

Speech recognition sometimes makes up text from silence or background noise. Move the microphone closer or use a headset. The dictated text is never sent without you: reread it before pressing `Enter`.

### Getting the most out of it

- **Search the help** before searching the menus: the **Rechercher dans l'aide** (Search the help) field finds a word in all the sections.
- **One conversation per subject.** A short thread gives more accurate and faster answers than a thread that mixes everything.
- **A question you ask often** is kept with the bookmark (**Sauvegarder** (Save)) on your message, then comes back through `/prompt`. See [Prompts](#prompts).
- **Before reporting a problem**, open **Informations** (About) in the account menu: the version shown will help your administrator.

## Troubleshooting
<!-- aide: probleme -->

What the application shows when something is wrong, what it means and what you can do. Most incidents are solved by waiting a few seconds, trying again or opening a new conversation.

### The essentials

1. **Read the message.** The application states the cause in a few words and offers the right button: **Continuer** (Continue), **Reprendre** (Resume), **Réessayer** (Retry) or **Nouveau chat** (New chat).
2. **Wait a moment, then try again.** A network outage or a server restart usually recovers by itself.
3. **Reload the page** if the screen stays frozen. Your conversations are saved on the server: you lose nothing.
4. **If the problem persists, tell your administrator**, with the items listed at the end of this section.

### Connection and session

#### "Identifiant ou mot de passe incorrect" (Incorrect login or password), or "Trop de tentatives" (Too many attempts)

Check what you typed, in particular capital letters; after several failures, login is suspended for a few minutes. If you have forgotten your password, your administrator can give you a new one.

#### "Serveur injoignable" (Server unreachable), or "Service momentanément indisponible" (Service temporarily unavailable)

The server is not responding or is restarting. Check your network connection, wait about ten seconds and try again. Your credentials were not refused.

#### "Session expirée" (Session expired)

Your session has reached its maximum duration, or the administrator closed it. Log in again: your conversations are intact.

#### "Le serveur redémarre…" (The server is restarting…)

A banner announces it during a restart. The page reconnects by itself; wait for it to disappear before sending a message.

### During an answer

#### "Reconnexion (1/2)..." (Reconnecting (1/2)...) stays displayed

The connection with the server has been cut. The application tries twice. If the indication persists, reload the page: the answer in progress continues on the server and reappears.

#### "Réponse interrompue" (Answer interrupted), or "Budget de tours atteint" (Turn budget reached)

**Continuer** completes an answer that stopped or was too long; if it is not offered, click **Régénérer la réponse** (Regenerate the answer). A stopped tool job ("Budget de tours atteint", "Budget de temps atteint" (Time budget reached)…) is restarted with **Reprendre**, in its banner. See [The chat](#the-chat).

#### "Interrompue" (Interrupted), followed by a cause

| Cause shown | What to do |
|---|---|
| **connexion perdue** (connection lost), **serveur injoignable** (server unreachable), **délai dépassé** (timeout) | Click **Reprendre** (or **Réessayer**) once the connection is back |
| **modèle en chargement** (model loading) | Wait a few seconds, then **Reprendre** |
| **moteur occupé** (engine busy), **trop de requêtes** (too many requests) | Other requests are in progress: wait, then **Reprendre** |
| **contexte saturé** (context full) | The conversation is too long for the model: **Nouveau chat**, or `/compact` |
| **accès refusé** (access denied), **requête refusée** (request denied) | Your account or this model does not allow this request: tell your administrator |
| **erreur interne** (internal error) | **Reprendre**; if the error comes back, click **Copier le détail** (Copy the detail) and pass it on |

#### "En attente…" (Waiting…) lasts a long time, or the answers are very slow

Many people are using the model at the same time, or the chosen model is heavy. Wait, or choose a lighter model. See [Models and providers](#models-and-providers).

#### "Aucun serveur autorisé" (No server allowed)

Your account has no access to any model, and the send button is blocked. Ask your administrator.

#### A model is marked "Échec" (Failed), or its server "Injoignable" (Unreachable)

The model could not be loaded, or its server is not responding. Click **Réessayer** next to the server name, or choose another model. If it lasts, tell your administrator.

#### The assistant does not follow my instructions

A **Prompt système** (System prompt) that is too long, or contradicted by the start of the conversation, is followed poorly. Shorten it in Paramètres (Settings) › **Chat** › **Conversation**, then open a new conversation.

### Files, tools and sandbox

#### The @ list is empty, or an attached file is refused

The `@` list shows the files of your sandbox: it is empty if the sandbox is not available. An attached file is refused beyond the limits given in [Attaching a file](#the-chat).

#### A command fails with "connexion refusée" (connection refused), or the assistant says it has no network

Your sandbox only has the network access that its profile allows. When several profiles are offered to you, choose another one on the **Réseau** (Network) row of Paramètres › **Avancé** (Advanced) › **Sandbox**. Otherwise, ask your administrator to open the destination.

#### A server preview shows a connection error

The service you started in the sandbox is not listening on that port, or the network profile does not allow it. Check that it is really started. See [The sandbox and the code editor](#the-sandbox-and-the-code-editor).

#### The editor stays frozen

Close the **Sandbox** panel, then reopen it. If that is not enough, reload the page.

#### An MCP server is in error

The server does not start or no longer responds. For a server you added, check its address; for a shared server, tell your administrator. See [Tools and the MCP panel](#tools-and-the-mcp-panel).

#### RAG is unavailable, or a document shows "Extracteur indisponible" (Extractor unavailable)

A service needed to read documents is stopped. Your collections stay in place and indexing resumes by itself when the service comes back. Tell your administrator.

### Voice

#### Dictation stops by itself

The application says so: the dictation engine no longer responds, or the tab was hidden. Restart the dictation with a click on the microphone. If the microphone does not appear at all, see [Frequently asked questions](#frequently-asked-questions).

### Getting the most out of it

- **Prefer Continuer to Régénérer** when an answer was cut off: the text already written is kept.
- **A conversation that is filling up is best treated early.** `/compact` summarizes the start of the thread; one new conversation per subject avoids getting there. See [The conversation context](#the-conversation-context).

### What to pass on to your administrator

For a problem that persists, give them what they need to find the incident:

- the time, and the title of the conversation concerned;
- what you were doing, and the message shown;
- the text obtained with **Copier le détail**, if it is offered;
- the version of the application, read in **Informations** (account menu).

Each request leaves a trace on the server side: with these items, the administrator can reconstruct precisely what happened.

## Administration console
<!-- aide: admin -->

The console sets up the application for everyone: accounts and rights, models and services, sandbox, backups, logs. It is reserved for administrators. Moderators only see **Vue d'ensemble** (Overview) and **Supervision** there, without the security log.

### The essentials

1. In the chat, click the shield icon **Administration**, at the bottom of the sidebar. The session is shared: you are already logged in.
2. The console opens on **Vue d'ensemble**. The **À traiter** (To handle) block lists what needs your attention; **Ouvrir** (Open) leads to the setting concerned.
3. Choose a page in the sidebar: six entries, each expanded into subpages.
4. Change a setting. A bar appears at the bottom of the page: click **Enregistrer** (Save).
5. **Retour au chat** (Back to the chat), at the bottom of the sidebar, takes you back to the conversation.

### Creating an account

[Create an account in the console: login and temporary password](media/aide/admin-comptes.webm)

1. Open **Utilisateurs & accès** (Users & access), page **Comptes** (Accounts).
2. Click **Créer un compte** (Create an account).
3. In **Nouvel utilisateur** (New user), enter the **Identifiant** (Login) and a **Mot de passe temporaire** (Temporary password). Choose the **Rôle** (Role): **Utilisateur** (User), **Modérateur** (Moderator) or **Administrateur** (Administrator).
4. Click **Créer** (Create). The account joins the list.

Pass the temporary password on to the person: they will have to change it at their first login.

On an account's row:

- **Modifier** (Edit) expands its settings. **Compte** (Account): **Rôle** and **Groupes** (Groups). **Inférence** (Inference): the allowed **Serveurs** (Servers) (**Hérité** (Inherited), **Tous** (All) or **Liste** (List)) and the right to manage **Modèles** (Models). **Sandbox et machines** (Sandbox and machines): the **Quota** in MB (0 = unlimited), the **Réseau** (Network) profile, the **Machines** that can be driven in the Studio and token access. Confirm with **Enregistrer**.
- The key resets the password. The account will have to change it at its next login.
- The trash can deletes the account, after confirmation. The console then asks whether to keep its sandbox.

Above the list, **Admins** and **Sans groupe** (No group) filter the accounts, and the **Nom ou groupe** (Name or group) field searches. Tick several accounts to add them to a group or delete them together.

### Changing a setting and saving it

[Change a console setting, then save it from the bottom bar](media/aide/admin-enregistrer.webm)

All the settings pages work the same way. Example with the password rule:

1. Open **Utilisateurs & accès**, page **Mots de passe & sessions** (Passwords & sessions).
2. Enter a **Longueur minimale** (Minimum length) and tick the **Caractères obligatoires** (Required characters) you want.
3. The bottom bar counts the changes: "2 modifications" (2 changes).
4. Click **Enregistrer**. The **Modifications enregistrées** (Changes saved) message confirms.

What you need to know:

- One screen, one save: nothing is written until you have saved.
- **Voir** (View) details each change, old and new value, and lets you **Rétablir** (Restore) a single one. **Annuler** (Cancel) abandons them all.
- Leaving the page with changes in progress opens a choice: **Rester** (Stay), **Ignorer** (Discard) or **Enregistrer**.
- If another administrator has changed the same value in the meantime, the console flags it. **Reprendre** (Resume) keeps their value and saves your other changes.
- Some settings are only read at startup. A **Redémarrage nécessaire** (Restart required) banner then stays on all the pages, with the number of pending settings, a **Détail** (Detail) link and a **Redémarrer** (Restart) button.

### The console pages

- **Vue d'ensemble**: **À traiter**, the state of the **Services** with **Tout tester** (Test all), the figures for the **Dernières 24 h** (Last 24 h) and the **Installation**.
- **Supervision**: **Métriques** (Metrics) (widgets of your choice, CSV export, Prometheus collection), **Rapport** (Report) (archived daily digest, preview before printing), **Activité** (Activity) (**Exécutions** (Runs) and **Appels d'outils** (Tool calls) tabs, with search, sorting and error filters), **Journaux** (Logs) (**Technique** (Technical) tab, and **Sécurité** (Security) tab for administrators).
- **Modèles & services** (Models & services): **Inférence** (engines, request scheduling), **Compression**, **RAG**, **Vision & machines** (annotation, the Studio's target machines), **Voix**, **Images**, **Outils MCP** (MCP tools), **Prompts** (system prompts by category), **Secrets** (those of the instance).
- **Utilisateurs & accès**: **Comptes**, **Groupes**, **Droits par défaut** (Default rights) (features, providers open to accounts), **Mots de passe & sessions**, **SSO OpenID Connect** (OpenID Connect single sign-on: providers, accounts to link).
- **Sandbox**: **Limites & politique** (Limits & policy) (memory, processor, processes, duration of a command, inactivity shutdown), **Réseau** (profiles), **Hôtes d'outils** (Tool hosts), **Conteneurs** (Containers), **Sous-agents** (Subagents).
- **Système** (System): **Instance** (identity, welcome screen, login page), **Apparence** (skins offered), **Accès HTTPS** (HTTPS access), **Données** (Data) (backup, database, restore), **Journalisation** (Logging), **Entretien** (Maintenance) (periodic maintenance, restart, metrics purge).

Dates are in local time; hover over them for the exact UTC time.

### First settings of an installation

The **Vue d'ensemble** flags what a new installation is missing. In order:

1. **Accès HTTPS** (**Système**): without it, passwords and cookies travel in clear text. The switch checks that the ports respond before cutting direct access, so as not to lock you out.
2. A password rule (**Mots de passe & sessions**): minimum length and required characters.
3. A backup (**Système**, page **Données**): local, then to a remote server.
4. An engine (**Modèles & services**, page **Inférence**), then the accounts and their groups.

### Everyday operations

- **Backup and restore** (**Données**): archive of the database (with the accounts' memory), the sandboxes and the MCP servers; the editor's file history (**Historique**) is not backed up; **Sauvegarde distante** (Remote backup) to another server (SFTP or rsync); restore **Complète** (Full), or limited to the **Base de données** (Database), the **Sandboxes** or the **Serveurs MCP** (MCP servers).
- **Changing database** (**Données**): **Simuler** (Simulate) checks the target database and counts what would be copied. **Migrer et basculer** (Migrate and switch) suspends writes, copies and verifies the data, then restarts the application on the new database. **Revenir à SQLite** (Return to SQLite) does the reverse. If the database server becomes unreachable: `./elpis db use sqlite` on the machine, then restart.
- **Skins** (**Système**, page **Apparence**): the **Actif** (Active) switch offers a skin to accounts, **Définir** (Set) chooses the default one. **Importer** (Import) adds a package, which arrives disabled. **Créer** (Create) starts from an existing skin, with a live preview. **Habillages personnels** (Personal skins) allows or not the skins created by accounts, with a **Plafond par compte** (Cap per account).
- **Sessions** (**Mots de passe & sessions**): login duration, logout on inactivity, **Révoquer toutes les sessions** (Revoke all sessions) to log everyone out except you.
- **Security log** (**Supervision**, page **Journaux**, **Sécurité** tab): logins, accounts, rights, settings, backups, exports. Filter by period, category, account or result; **Plus ancien** (Older) goes back in time. **Exporter** (Export) produces a CSV or JSONL file, 366 days at most; each export is itself logged. **Vérifier l'intégrité** (Verify integrity) checks signatures and continuity over the period.
- **Journalisation** (**Système**): retention period of the security log (365 days by default), state of the centralization to the host's syslog, **Écrire un événement de test** (Write a test event). **Geler la purge** (Freeze the purge) keeps all the files during an investigation: a reason is required, confirm by typing `GELER`, lift by typing `LEVER`. Server-side setup is done with `sudo ./elpis audit setup`.
- **A sandbox with no way out** (**Sandbox**, page **Réseau**): **Tout bloquer** (Block everything) cuts the sandbox's network, and the driven browser follows it. The assistant's Git tools still go through the host's Git relay, which follows the profile's **Relais Git** (Git relay) rule, **Tous** (All) by default. For nothing to leave over the network, choose **Serveurs choisis** (Chosen servers) and list none: the profile's card then shows **Dépôts Git** (Git repositories) refused. With **Sudo** allowed (**Limites & politique**), root in such a sandbox still has no network. The network changes when the sandbox is next used, since it is then recreated; the Git rule applies at once. Remote MCP servers and the Studio's machines are driven by the application, outside the sandbox, and follow their own settings.
- **What the assistant is told** (**Sandbox**, page **Réseau**): at every turn, its context gives the network level of the account's profile with its allowed domains and ports, and the Git servers chosen for the relay; the address ranges and DNS resolvers of a list are only counted. With an external model provider, this text leaves with the conversation.

### Getting the most out of it

- `Ctrl+K` opens the console search: pages, settings and actions. Type `sauveg` and confirm: **Télécharger une sauvegarde** (Download a backup) starts without going through the menus. The arrows choose, `Enter` opens.
- `Ctrl+S` saves the current page.
- The **Rechercher une page** (Search for a page) field, at the top of the sidebar, filters the navigation. It also finds a page by the name of one of its settings.
- In **À traiter**, some rows act directly: **Télécharger une sauvegarde**, **Redémarrer**.
- **Tout tester**, on the **Vue d'ensemble**, reruns the check of all the services at once.
- Set rights through **Groupes** rather than account by account: in an account, **Hérité** follows the groups.
- The moon, at the bottom of the sidebar, switches the console to dark or light without touching the accounts.
- After a security incident, **Révoquer toutes les sessions** forces everyone to log in again; an account's key also forces a new password.

### How it works

The console runs in a process separate from the chat: a flaw on the application side does not give access to the administration functions. The settings are read by the application as soon as they are saved, except those that the **Redémarrage nécessaire** banner flags.
