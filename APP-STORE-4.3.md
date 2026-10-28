# Réponse au refus 4.3(a) (spam) — 28 octobre 2026

Refus reçu le 28 octobre sur la version 1.0 (soumission df6704ca), avec la mention « Extended Review » : « shares a similar binary, metadata, and/or concept as apps submitted to the App Store by you or other developers ». Apple ne nomme aucune app.

Cause probable : Panache est parti d'un fork de Battle Drones (Simon Willison, Apache 2.0, github.com/simonw/battledrones), jouable gratuitement sur le web et forké six fois sur GitHub. La fiche le disait en dernière ligne (« D'après Battle Drones, le jeu open source de Simon Willison »), environ 66 000 des 77 000 lignes de code d'origine sont encore là (simulation, cartes, moteur 3D), et l'app embarquait le site, les batailles de démonstration des agents d'IA et des clés `battledrones.*`.

## Ce qui a changé (commit 933f1d6)

- Clés de stockage, caches et fichiers renommés `panache.*` ; les anciennes données de l'appareil et du nuage sont reprises.
- L'app n'embarque plus les pages du site, les batailles de démonstration, vehicles.html ni record-viewer.html (tools/ios-prune.mjs) ; la licence Apache 2.0 part avec elle (LICENSE.txt).
- La rediffusion ne parle plus des outils de développement de Battle Drones.
- Fiche App Store (fr-FR, en-US, en-GB) : la ligne « D'après Battle Drones » est retirée. Le crédit reste dans le jeu (pied du menu), comme la licence le demande.

## À faire avant d'envoyer

1. Nouveau build : `sh tools/ios-testflight.sh`, puis le rattacher à la version 1.0.
2. Une vidéo de 60 à 90 s jointe à la revue : la campagne (intertitres, film muet), le choix de nation, un duel en ligne, Game Center.
3. Coller le texte ci-dessous au Resolution Center, puis resoumettre.
4. Ne rien soumettre d'autre du compte (Rature, Mémoire vive, Ressources inhumaines) avant la réponse d'Apple.

## Texte à coller dans le Resolution Center (anglais)

> Thank you for the review. We would like to explain where Panache comes from and what we changed in the new build.
>
> Panache began as a fork of Battle Drones, an open-source browser RTS released by Simon Willison under the Apache 2.0 license (github.com/simonw/battledrones). That is the resemblance you found: our previous build still used that project's internal storage names, bundled its website pages and its AI-agent demo battles, and our description named it. Battle Drones is not on the App Store, and Panache does not share code with any other app we have submitted.
>
> The new build removes every inherited identifier, the bundled website and the demo battles, and the description no longer refers to the original project. As the license requires, the attribution and the Apache 2.0 license stay inside the app.
>
> What players find in Panache was made for it and does not exist in Battle Drones or in its forks:
> • A Belle Époque setting, Paris 1900: every unit, building, map, menu and illustration redrawn for it, with a cinematograph title screen and intro film.
> • Two asymmetric nations, the Republic (fast, airborne, electric) and the Empire (steam, steel, artillery), each with its own units, powers, crests and music; the Republic fields the Zénith, a flying cruiser that docks and serves as an airborne base.
> • The 1900 Campaign: twelve missions in three acts, told like a silent film with intertitles, in three difficulty levels, plus a guided first mission.
> • Online duels over the internet with a four-letter code or a link, and ranked matches against players of your level (the original only had a local duel played through the phones' speakers).
> • Sign in with Apple cloud saves and Game Center: 21 achievements and 3 leaderboards.
> • A recorded announcer, over 600 voice lines in French and as many in English, and the whole game in both languages.
> • Touch controls built for the phone: draw a route with a finger, waypoints and patrols, the iPhone Duo's folded and unfolded screens, and resuming an interrupted match.
>
> A short video of these features is attached to the review. We would be grateful if you could review the new build.
