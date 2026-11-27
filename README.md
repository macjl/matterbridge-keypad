# Matterbridge Clavier

[![CI](https://github.com/macjl/matterbridge-securitysystem-keypad/actions/workflows/ci.yml/badge.svg)](https://github.com/macjl/matterbridge-securitysystem-keypad/actions/workflows/ci.yml)

**Préversion 0.2.0-alpha.2 · Apache-2.0 · Matterbridge ≥ 3.11.2 · Node.js 24 recommandé**

Un pavé web et un pavé numérique USB Linux qui valident des codes locaux puis exécutent des commandes Matter. Les commandes passent directement par Matter, sans API HTTP entre plugins.

![Interface de configuration](docs/images/overview.png)

## Fonctionnement

1. Partager les appareils à commander au contrôleur du clavier depuis leur contrôleur existant.
2. Créer des codes nommés de 4 à 12 chiffres, y compris les zéros initiaux. Aucun PIN n’est créé par défaut.
3. Créer des séquences : préfixe unique de 1 à 4 symboles parmi `+ - * / .`, codes autorisés et commandes à exécuter dans l’ordre.
4. Saisir **préfixe → code → Entrée**, ou choisir la séquence dans le pavé web puis saisir le code.

Exemple : `+` pour Away et `-` pour Désarmer. Retour arrière corrige ; Échap efface. Les saisies web et USB sont séparées. Les codes sont salés et hachés avec scrypt, la saisie expire et le blocage après erreurs est global et persistant. Une erreur de commande arrête la suite, sans annuler les commandes déjà exécutées. Une commande On/Off réussie nécessite la confirmation de l’état reçu par abonnement.

Pour commander [Alarme](https://github.com/macjl/matterbridge-securitysystem-core), envoyer Allumer à l’endpoint du mode ou à Désarmer. Autoriser le contrôleur Matterbridge Keypad dans les réglages de l’alarme s’il doit désarmer indépendamment de Maison.

## USB

L’entrée USB est optionnelle et désactivée par défaut. Sur Linux, compiler le module evdev avec `npm run build:usb` (compilateur C, en-têtes Node.js et Linux nécessaires). L’image Docker le compile automatiquement pour son architecture.

Transmettre uniquement un pavé dédié, par exemple avec `--device /dev/input/by-id/IDENTIFIANT-event-kbd:/dev/input/alarm-keypad:r`. Dans l’interface, activer l’USB et sélectionner `/dev/input/alarm-keypad`. Le mode exclusif réserve ce périphérique au plugin. Ne pas utiliser le clavier principal de la machine.

Le lecteur gère les formats Linux 32/64 bits, ignore les répétitions et efface la saisie après une perte de synchronisation ou déconnexion. Un périphérique absent n’empêche pas le pavé web de fonctionner. Un débranchement/rebranchement peut nécessiter de recréer le conteneur pour actualiser la transmission du périphérique.

Le clavier agit comme contrôleur ; il n’expose pas d’accessoire supplémentaire et n’utilise pas le cluster multimédia Keypad Input. La validation USB physique reste à effectuer avec le pavé dédié.

## Installation locale

```sh
git clone https://github.com/macjl/matterbridge-securitysystem-keypad.git
cd matterbridge-securitysystem-keypad
# Enregistrer le dossier dans une installation Matterbridge existante :
matterbridge --add "$PWD"
```

La page de configuration se trouve à `/plugins/matterbridge-securitysystem-keypad/` sur le serveur web Matterbridge. Se connecter à Matterbridge avant de l’ouvrir ; aucune clé supplémentaire n’est requise. Les API sont protégées par Matterbridge et une version antérieure à 3.11.2 est refusée.

## Docker

```sh
docker build -t matterbridge-securitysystem-keypad:local .
docker compose up -d --no-build
```

L’image est basée sur Matterbridge 3.11.2 et utilise un volume `/data`. Ne pas supprimer ce volume : il contient notamment les jumelages. HTTP écoute sur 8284 et Matter sur UDP 5545 par défaut. `POC_HTTP_BIND`, `POC_HTTP_PORT`, `POC_MATTER_PORT`, `POC_MDNS_INTERFACE` et `POC_DATA_DIR` restent les paramètres de déploiement compatibles avec le prototype.

Pour réunir les trois plugins dans un conteneur, cloner les trois dépôts côte à côte et utiliser `scripts/build-stack.sh` du dépôt Alarme, puis les overrides `compose.stack.yaml` des dépôts Audio et Clavier. Chaque plugin fonctionne aussi seul. Les images ne contiennent ni code PIN, ni clé privée, ni configuration personnelle.

## Développement et validation

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

La CI vérifie les sources, les tests et le contenu du paquet avec Node.js 24. Matterbridge fournit ses API à l’exécution ; conformément à ses contraintes, le plugin ne déclare pas Matterbridge ou matter.js dans ses dépendances. Les tests des interfaces utilisent un contrôleur simulé ; les essais Matter réseau utilisent des conteneurs et un stockage jetables. Ils n’accèdent pas à l’installation réelle.

Après construction de la pile, lancer `KEYPAD_TEST_IMAGE=matterbridge-securitysystem-stack:local bash test/run-integration.sh` et `KEYPAD_TEST_IMAGE=matterbridge-securitysystem-stack:local bash test/run-auth.sh`. Ces essais couvrent les commandes Matter, les refus d’accès et le redémarrage. Les tests simulent la lecture USB ; ils ne réservent aucun clavier physique.

Cette préversion sert à poursuivre les essais. Les scénarios matériels et la configuration de production restent à valider sur l’installation cible.
