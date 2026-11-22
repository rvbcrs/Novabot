# Spanish (es-AR) translation — contribution offer

> Community contribution from a Novabot owner running OpenNova. This is an
> **offer** to the maintainer: a full Spanish (Rioplatense / es-AR) translation
> of the interface, ready to fold into the project if wanted.

## English

A complete Spanish translation of the OpenNova interface strings was produced
and is in daily use. It covers:

- the **app** / dashboard UI,
- the **admin** panel,
- the server-side user-facing text (API messages and diagnosis text),
- runtime error messages (the firmware emits them in English; they are mapped to
  Spanish for display).

The translation follows the project's existing `i18n` structure
(`react-i18next`, the `src/i18n` folders), so it drops in as an additional
locale rather than replacing anything. The English source strings are kept as
the key set; Spanish is added as a sibling locale.

Work was already pushed to a fork as topic branches
(`feat/admin-spanish`, `feat/dashboard-spanish`) and offered upstream as pull
requests. This note groups the effort in one place and makes the offer explicit:
**happy to open / refresh PRs, split them per surface, or adjust the locale code
or wording to whatever the maintainer prefers.**

A note on merge order we hit in practice: if other feature branches add new
UI strings, those keys also need an `es` entry or the TypeScript build fails —
worth syncing locales when merging feature PRs together.

## Español

Se hizo una traducción completa de la interfaz de OpenNova al español
(rioplatense / es-AR) y está en uso diario. Cubre:

- la interfaz de la **app** / dashboard,
- el panel de **administración**,
- los textos de cara al usuario del servidor (mensajes de la API y textos de
  diagnóstico),
- los mensajes de error en tiempo de ejecución (el firmware los emite en inglés;
  se mapean al español para mostrarlos).

La traducción respeta la estructura `i18n` del proyecto (`react-i18next`, las
carpetas `src/i18n`): se agrega como un idioma más, sin reemplazar nada. Las
cadenas en inglés quedan como claves y el español se suma como idioma hermano.

El trabajo ya se subió a un fork en ramas temáticas
(`feat/admin-spanish`, `feat/dashboard-spanish`) y se ofreció como pull requests.
Este documento junta todo en un solo lugar y hace explícita la oferta:
**con gusto abrimos o actualizamos los PRs, los separamos por sección, o
ajustamos el código de idioma o la redacción a lo que prefiera quien mantiene el
proyecto.**

Un detalle de orden de merge que apareció en la práctica: si otras ramas agregan
cadenas nuevas de la interfaz, esas claves también necesitan su entrada `es` o
falla la compilación de TypeScript; conviene sincronizar los idiomas al mergear
PRs de features juntos.
