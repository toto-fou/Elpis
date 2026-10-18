// SPDX-License-Identifier: MIT
/** packages/commun/src/index.ts — point d'entrée des utilitaires partagés. */
export {
  canonicalJson,
  comparePointsDeCode,
  FlottantPy,
  pyJsonDumps,
  reprFlottant,
  versFlottantPy,
} from "./json";
export type { OptionsDumps } from "./json";
export {
  chargerJsonPy,
  decoderJsonPy,
  ErreurJsonPy,
  ErreurLecturePy,
  pyJsonLoads,
  pyJsonLoadsOctets,
  texteJsonPy,
} from "./json-lecture";
export type { ModeJsonLoads } from "./json-lecture";
export { ErreurValidation, HttpError } from "./erreurs-http";
export type { Emplacement, ErreurPydantic } from "./erreurs-http";
export {
  BLANC_PY,
  encoderUtf8Py,
  entierOuNulPy,
  ErreurPython,
  estAlnumPy,
  estBlancPy,
  estChiffresPy,
  estEntierPy,
  estErreurPython,
  findPy,
  floatPy,
  intPy,
  longueurPy,
  lowerPy,
  lstripPy,
  maxPy,
  minPy,
  nonVidePy,
  prefixePy,
  reprPy,
  rfindPy,
  rstripPy,
  splitlinesPy,
  splitPy,
  stripPy,
  strPy,
  suffixePy,
  texteUtf8,
  utf8Remplace,
  veritePy,
} from "./python";
export type { TypeErreurPython } from "./python";
export {
  hostname,
  port,
  quoteLatin1,
  quotePy,
  urljoin,
  urlparse,
  urlsplit,
  urlunparse,
  urlunsplit,
} from "./url";
export type { UrlDecoupee, UrlParsee } from "./url";
export { arrondiEntierPy, arrondiPy, entierExactPy, fixePy, flottantStrictPy } from "./nombres";
export {
  cleHashPy,
  contientPy,
  copieProfondePy,
  copieDict,
  dictOuVide,
  dictPy,
  ErreurCle,
  estDict,
  exigerDict,
  getOu,
  getPy,
  inPy,
  isdigitPy,
  itemPy,
  iterExige,
  iterPy,
  lire,
  mettreAJourPy,
  nomTypePy,
  objetNu,
  ouPy,
  poserCle,
  texteNet,
  texteOu,
} from "./dict";
export type { Dict } from "./dict";
export {
  CancelledError,
  delaiMinuterie,
  dormirMs,
  estAnnulationDemandee,
  estErreurAnnulation,
  raisonAnnulation,
} from "./annulation";
export { clesOrdonnees, estCleEntiere, noterOrdreDesCles } from "./ordre";
export { brancherJournal, journalDe, journalStderr } from "./journal";
export type { FabriqueJournal, Journal } from "./journal";
export { asciiPy, formatGabarit, formatPy } from "./format";
export { ErreurFormat, formatValeur, formatValeursPy } from "./format-valeurs";
export type { TypeErreurFormat, ValeurFormat } from "./format-valeurs";
export { casefoldPy, nfcPy, sansAccentsPy } from "./unicode";
export {
  decoderUtf8,
  decoderUtf8IgnorePy,
  decoderUtf8Py,
  ErreurDecodage,
  estDossierPy,
  estErreurValeur,
  estFichierPy,
  existePy,
  lireTextePy,
  messageErreurOs,
  messageErreurPy,
  messageRmtree,
  stMtimePy,
} from "./fichiers";
export { fnmatchPy, normpathPy, pyJoin, pyParent, pyPath, realpathPy } from "./chemins";
export { egalPy, inferieurPy, trierPy } from "./comparaisons";
export { JSONDecodeError, jsonLoads, rawDecodePy } from "./json-brut";
export { motifPy } from "./motifs";
export { FICHIERS_CONNUS, guessTypePy, TypesMime } from "./mimetypes";
export {
  chercher,
  chercherRe,
  compilerPy,
  compilerRe,
  compilerReGroupes,
  echapperPy,
  EQUIVALENCES_CASSE,
  ErreurPyRe,
  ErreurRe,
  gabaritPy,
  RE_ASCII,
  RE_DOTALL,
  RE_IGNORECASE,
  RE_LOCALE,
  RE_MULTILINE,
  RE_UNICODE,
  RE_VERBOSE,
  RegexNonGeree,
  subn,
  trouverTout,
} from "./regex-py";
export type { Correspondance, MotifPy, ReCompile } from "./regex-py";
export { blocsCorrespondants, getCloseMatches, opcodes, opcodesGroupes, ratio, unifiedDiff } from "./difflib";
export type { Bloc, Opcode } from "./difflib";
export {
  ArchiveZip,
  dateHeureLocale,
  decoderNom,
  ecrireZip,
  ErreurZip,
  finArchive,
  membresDuRepertoire,
  NOMS_COMPRESSION,
} from "./zip";
export type { DateHeureZip, EntreeZipEcrite, MembreZip, TypeErreurZip } from "./zip";
export {
  adresseIpOuNul,
  adresseIpPy,
  dansReseau,
  estBoucleIp,
  estGlobaleIp,
  estLienLocalIp,
  estMulticastIp,
  estNonSpecifieeIp,
  estPriveeIp,
  estReserveeIp,
  ipv4Mappee,
  ipv4Py,
  ipv6Py,
  masqueIp,
  reseauPy,
  texteIp,
} from "./adresse-ip";
export type { AdresseIp, Reseau } from "./adresse-ip";
