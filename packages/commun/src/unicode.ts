// SPDX-License-Identifier: MIT
/** packages/commun/src/unicode.ts — casefold, NFC et NFKD sans marques combinantes d'Unicode 15.1 (Python 3.13), indépendants de l'ICU de Node. */
import { lowerPy } from "./python";

type Plages = readonly (readonly [number, number])[];

function plages(table: string): Plages {
  return table.split(" ").map((p) => {
    const [debut = "", fin = debut] = p.split("-");
    return [Number.parseInt(debut, 16), Number.parseInt(fin, 16)] as const;
  });
}

function dans(table: Plages, code: number): boolean {
  let bas = 0;
  let haut = table.length - 1;
  while (bas <= haut) {
    const milieu = (bas + haut) >> 1;
    const [debut, fin] = table[milieu] ?? [0, -1];
    if (code < debut) haut = milieu - 1;
    else if (code > fin) bas = milieu + 1;
    else return true;
  }
  return false;
}

/** Points de code assignés en Unicode 15.1 (catégorie autre que « Cn », hors demi-paires) : les autres restent tels quels, comme dans Python 3.13. */
const ASSIGNES_15 = plages(
  "0-377 37a-37f 384-38a 38c 38e-3a1 3a3-52f 531-556 559-58a 58d-58f 591-5c7 5d0-5ea 5ef-5f4 600-70d " +
    "70f-74a 74d-7b1 7c0-7fa 7fd-82d 830-83e 840-85b 85e 860-86a 870-88e 890-891 898-983 985-98c 98f-990 " +
    "993-9a8 9aa-9b0 9b2 9b6-9b9 9bc-9c4 9c7-9c8 9cb-9ce 9d7 9dc-9dd 9df-9e3 9e6-9fe a01-a03 a05-a0a " +
    "a0f-a10 a13-a28 a2a-a30 a32-a33 a35-a36 a38-a39 a3c a3e-a42 a47-a48 a4b-a4d a51 a59-a5c a5e a66-a76 " +
    "a81-a83 a85-a8d a8f-a91 a93-aa8 aaa-ab0 ab2-ab3 ab5-ab9 abc-ac5 ac7-ac9 acb-acd ad0 ae0-ae3 ae6-af1 " +
    "af9-aff b01-b03 b05-b0c b0f-b10 b13-b28 b2a-b30 b32-b33 b35-b39 b3c-b44 b47-b48 b4b-b4d b55-b57 " +
    "b5c-b5d b5f-b63 b66-b77 b82-b83 b85-b8a b8e-b90 b92-b95 b99-b9a b9c b9e-b9f ba3-ba4 ba8-baa bae-bb9 " +
    "bbe-bc2 bc6-bc8 bca-bcd bd0 bd7 be6-bfa c00-c0c c0e-c10 c12-c28 c2a-c39 c3c-c44 c46-c48 c4a-c4d " +
    "c55-c56 c58-c5a c5d c60-c63 c66-c6f c77-c8c c8e-c90 c92-ca8 caa-cb3 cb5-cb9 cbc-cc4 cc6-cc8 cca-ccd " +
    "cd5-cd6 cdd-cde ce0-ce3 ce6-cef cf1-cf3 d00-d0c d0e-d10 d12-d44 d46-d48 d4a-d4f d54-d63 d66-d7f " +
    "d81-d83 d85-d96 d9a-db1 db3-dbb dbd dc0-dc6 dca dcf-dd4 dd6 dd8-ddf de6-def df2-df4 e01-e3a e3f-e5b " +
    "e81-e82 e84 e86-e8a e8c-ea3 ea5 ea7-ebd ec0-ec4 ec6 ec8-ece ed0-ed9 edc-edf f00-f47 f49-f6c f71-f97 " +
    "f99-fbc fbe-fcc fce-fda 1000-10c5 10c7 10cd 10d0-1248 124a-124d 1250-1256 1258 125a-125d 1260-1288 " +
    "128a-128d 1290-12b0 12b2-12b5 12b8-12be 12c0 12c2-12c5 12c8-12d6 12d8-1310 1312-1315 1318-135a " +
    "135d-137c 1380-1399 13a0-13f5 13f8-13fd 1400-169c 16a0-16f8 1700-1715 171f-1736 1740-1753 1760-176c " +
    "176e-1770 1772-1773 1780-17dd 17e0-17e9 17f0-17f9 1800-1819 1820-1878 1880-18aa 18b0-18f5 1900-191e " +
    "1920-192b 1930-193b 1940 1944-196d 1970-1974 1980-19ab 19b0-19c9 19d0-19da 19de-1a1b 1a1e-1a5e " +
    "1a60-1a7c 1a7f-1a89 1a90-1a99 1aa0-1aad 1ab0-1ace 1b00-1b4c 1b50-1b7e 1b80-1bf3 1bfc-1c37 1c3b-1c49 " +
    "1c4d-1c88 1c90-1cba 1cbd-1cc7 1cd0-1cfa 1d00-1f15 1f18-1f1d 1f20-1f45 1f48-1f4d 1f50-1f57 1f59 1f5b " +
    "1f5d 1f5f-1f7d 1f80-1fb4 1fb6-1fc4 1fc6-1fd3 1fd6-1fdb 1fdd-1fef 1ff2-1ff4 1ff6-1ffe 2000-2064 " +
    "2066-2071 2074-208e 2090-209c 20a0-20c0 20d0-20f0 2100-218b 2190-2426 2440-244a 2460-2b73 2b76-2b95 " +
    "2b97-2cf3 2cf9-2d25 2d27 2d2d 2d30-2d67 2d6f-2d70 2d7f-2d96 2da0-2da6 2da8-2dae 2db0-2db6 2db8-2dbe " +
    "2dc0-2dc6 2dc8-2dce 2dd0-2dd6 2dd8-2dde 2de0-2e5d 2e80-2e99 2e9b-2ef3 2f00-2fd5 2ff0-303f 3041-3096 " +
    "3099-30ff 3105-312f 3131-318e 3190-31e3 31ef-321e 3220-a48c a490-a4c6 a4d0-a62b a640-a6f7 a700-a7ca " +
    "a7d0-a7d1 a7d3 a7d5-a7d9 a7f2-a82c a830-a839 a840-a877 a880-a8c5 a8ce-a8d9 a8e0-a953 a95f-a97c " +
    "a980-a9cd a9cf-a9d9 a9de-a9fe aa00-aa36 aa40-aa4d aa50-aa59 aa5c-aac2 aadb-aaf6 ab01-ab06 ab09-ab0e " +
    "ab11-ab16 ab20-ab26 ab28-ab2e ab30-ab6b ab70-abed abf0-abf9 ac00-d7a3 d7b0-d7c6 d7cb-d7fb e000-fa6d " +
    "fa70-fad9 fb00-fb06 fb13-fb17 fb1d-fb36 fb38-fb3c fb3e fb40-fb41 fb43-fb44 fb46-fbc2 fbd3-fd8f " +
    "fd92-fdc7 fdcf fdf0-fe19 fe20-fe52 fe54-fe66 fe68-fe6b fe70-fe74 fe76-fefc feff ff01-ffbe ffc2-ffc7 " +
    "ffca-ffcf ffd2-ffd7 ffda-ffdc ffe0-ffe6 ffe8-ffee fff9-fffd 10000-1000b 1000d-10026 10028-1003a " +
    "1003c-1003d 1003f-1004d 10050-1005d 10080-100fa 10100-10102 10107-10133 10137-1018e 10190-1019c " +
    "101a0 101d0-101fd 10280-1029c 102a0-102d0 102e0-102fb 10300-10323 1032d-1034a 10350-1037a " +
    "10380-1039d 1039f-103c3 103c8-103d5 10400-1049d 104a0-104a9 104b0-104d3 104d8-104fb 10500-10527 " +
    "10530-10563 1056f-1057a 1057c-1058a 1058c-10592 10594-10595 10597-105a1 105a3-105b1 105b3-105b9 " +
    "105bb-105bc 10600-10736 10740-10755 10760-10767 10780-10785 10787-107b0 107b2-107ba 10800-10805 " +
    "10808 1080a-10835 10837-10838 1083c 1083f-10855 10857-1089e 108a7-108af 108e0-108f2 108f4-108f5 " +
    "108fb-1091b 1091f-10939 1093f 10980-109b7 109bc-109cf 109d2-10a03 10a05-10a06 10a0c-10a13 " +
    "10a15-10a17 10a19-10a35 10a38-10a3a 10a3f-10a48 10a50-10a58 10a60-10a9f 10ac0-10ae6 10aeb-10af6 " +
    "10b00-10b35 10b39-10b55 10b58-10b72 10b78-10b91 10b99-10b9c 10ba9-10baf 10c00-10c48 10c80-10cb2 " +
    "10cc0-10cf2 10cfa-10d27 10d30-10d39 10e60-10e7e 10e80-10ea9 10eab-10ead 10eb0-10eb1 10efd-10f27 " +
    "10f30-10f59 10f70-10f89 10fb0-10fcb 10fe0-10ff6 11000-1104d 11052-11075 1107f-110c2 110cd " +
    "110d0-110e8 110f0-110f9 11100-11134 11136-11147 11150-11176 11180-111df 111e1-111f4 11200-11211 " +
    "11213-11241 11280-11286 11288 1128a-1128d 1128f-1129d 1129f-112a9 112b0-112ea 112f0-112f9 " +
    "11300-11303 11305-1130c 1130f-11310 11313-11328 1132a-11330 11332-11333 11335-11339 1133b-11344 " +
    "11347-11348 1134b-1134d 11350 11357 1135d-11363 11366-1136c 11370-11374 11400-1145b 1145d-11461 " +
    "11480-114c7 114d0-114d9 11580-115b5 115b8-115dd 11600-11644 11650-11659 11660-1166c 11680-116b9 " +
    "116c0-116c9 11700-1171a 1171d-1172b 11730-11746 11800-1183b 118a0-118f2 118ff-11906 11909 " +
    "1190c-11913 11915-11916 11918-11935 11937-11938 1193b-11946 11950-11959 119a0-119a7 119aa-119d7 " +
    "119da-119e4 11a00-11a47 11a50-11aa2 11ab0-11af8 11b00-11b09 11c00-11c08 11c0a-11c36 11c38-11c45 " +
    "11c50-11c6c 11c70-11c8f 11c92-11ca7 11ca9-11cb6 11d00-11d06 11d08-11d09 11d0b-11d36 11d3a " +
    "11d3c-11d3d 11d3f-11d47 11d50-11d59 11d60-11d65 11d67-11d68 11d6a-11d8e 11d90-11d91 11d93-11d98 " +
    "11da0-11da9 11ee0-11ef8 11f00-11f10 11f12-11f3a 11f3e-11f59 11fb0 11fc0-11ff1 11fff-12399 " +
    "12400-1246e 12470-12474 12480-12543 12f90-12ff2 13000-13455 14400-14646 16800-16a38 16a40-16a5e " +
    "16a60-16a69 16a6e-16abe 16ac0-16ac9 16ad0-16aed 16af0-16af5 16b00-16b45 16b50-16b59 16b5b-16b61 " +
    "16b63-16b77 16b7d-16b8f 16e40-16e9a 16f00-16f4a 16f4f-16f87 16f8f-16f9f 16fe0-16fe4 16ff0-16ff1 " +
    "17000-187f7 18800-18cd5 18d00-18d08 1aff0-1aff3 1aff5-1affb 1affd-1affe 1b000-1b122 1b132 " +
    "1b150-1b152 1b155 1b164-1b167 1b170-1b2fb 1bc00-1bc6a 1bc70-1bc7c 1bc80-1bc88 1bc90-1bc99 " +
    "1bc9c-1bca3 1cf00-1cf2d 1cf30-1cf46 1cf50-1cfc3 1d000-1d0f5 1d100-1d126 1d129-1d1ea 1d200-1d245 " +
    "1d2c0-1d2d3 1d2e0-1d2f3 1d300-1d356 1d360-1d378 1d400-1d454 1d456-1d49c 1d49e-1d49f 1d4a2 " +
    "1d4a5-1d4a6 1d4a9-1d4ac 1d4ae-1d4b9 1d4bb 1d4bd-1d4c3 1d4c5-1d505 1d507-1d50a 1d50d-1d514 " +
    "1d516-1d51c 1d51e-1d539 1d53b-1d53e 1d540-1d544 1d546 1d54a-1d550 1d552-1d6a5 1d6a8-1d7cb " +
    "1d7ce-1da8b 1da9b-1da9f 1daa1-1daaf 1df00-1df1e 1df25-1df2a 1e000-1e006 1e008-1e018 1e01b-1e021 " +
    "1e023-1e024 1e026-1e02a 1e030-1e06d 1e08f 1e100-1e12c 1e130-1e13d 1e140-1e149 1e14e-1e14f " +
    "1e290-1e2ae 1e2c0-1e2f9 1e2ff 1e4d0-1e4f9 1e7e0-1e7e6 1e7e8-1e7eb 1e7ed-1e7ee 1e7f0-1e7fe " +
    "1e800-1e8c4 1e8c7-1e8d6 1e900-1e94b 1e950-1e959 1e95e-1e95f 1ec71-1ecb4 1ed01-1ed3d 1ee00-1ee03 " +
    "1ee05-1ee1f 1ee21-1ee22 1ee24 1ee27 1ee29-1ee32 1ee34-1ee37 1ee39 1ee3b 1ee42 1ee47 1ee49 1ee4b " +
    "1ee4d-1ee4f 1ee51-1ee52 1ee54 1ee57 1ee59 1ee5b 1ee5d 1ee5f 1ee61-1ee62 1ee64 1ee67-1ee6a " +
    "1ee6c-1ee72 1ee74-1ee77 1ee79-1ee7c 1ee7e 1ee80-1ee89 1ee8b-1ee9b 1eea1-1eea3 1eea5-1eea9 " +
    "1eeab-1eebb 1eef0-1eef1 1f000-1f02b 1f030-1f093 1f0a0-1f0ae 1f0b1-1f0bf 1f0c1-1f0cf 1f0d1-1f0f5 " +
    "1f100-1f1ad 1f1e6-1f202 1f210-1f23b 1f240-1f248 1f250-1f251 1f260-1f265 1f300-1f6d7 1f6dc-1f6ec " +
    "1f6f0-1f6fc 1f700-1f776 1f77b-1f7d9 1f7e0-1f7eb 1f7f0 1f800-1f80b 1f810-1f847 1f850-1f859 " +
    "1f860-1f887 1f890-1f8ad 1f8b0-1f8b1 1f900-1fa53 1fa60-1fa6d 1fa70-1fa7c 1fa80-1fa88 1fa90-1fabd " +
    "1fabf-1fac5 1face-1fadb 1fae0-1fae8 1faf0-1faf8 1fb00-1fb92 1fb94-1fbca 1fbf0-1fbf9 20000-2a6df " +
    "2a700-2b739 2b740-2b81d 2b820-2cea1 2ceb0-2ebe0 2ebf0-2ee5d 2f800-2fa1d 30000-3134a 31350-323af " +
    "e0001 e0020-e007f e0100-e01ef f0000-ffffd 100000-10fffd",
);

/** `unicodedata.combining(c) != 0` en Unicode 15.1. */
const COMBINANTS_15 = plages(
  "300-34e 350-36f 483-487 591-5bd 5bf 5c1-5c2 5c4-5c5 5c7 610-61a 64b-65f 670 6d6-6dc 6df-6e4 6e7-6e8 " +
    "6ea-6ed 711 730-74a 7eb-7f3 7fd 816-819 81b-823 825-827 829-82d 859-85b 898-89f 8ca-8e1 8e3-8ff 93c " +
    "94d 951-954 9bc 9cd 9fe a3c a4d abc acd b3c b4d bcd c3c c4d c55-c56 cbc ccd d3b-d3c d4d dca e38-e3a " +
    "e48-e4b eb8-eba ec8-ecb f18-f19 f35 f37 f39 f71-f72 f74 f7a-f7d f80 f82-f84 f86-f87 fc6 1037 " +
    "1039-103a 108d 135d-135f 1714-1715 1734 17d2 17dd 18a9 1939-193b 1a17-1a18 1a60 1a75-1a7c 1a7f " +
    "1ab0-1abd 1abf-1ace 1b34 1b44 1b6b-1b73 1baa-1bab 1be6 1bf2-1bf3 1c37 1cd0-1cd2 1cd4-1ce0 1ce2-1ce8 " +
    "1ced 1cf4 1cf8-1cf9 1dc0-1dff 20d0-20dc 20e1 20e5-20f0 2cef-2cf1 2d7f 2de0-2dff 302a-302f 3099-309a " +
    "a66f a674-a67d a69e-a69f a6f0-a6f1 a806 a82c a8c4 a8e0-a8f1 a92b-a92d a953 a9b3 a9c0 aab0 aab2-aab4 " +
    "aab7-aab8 aabe-aabf aac1 aaf6 abed fb1e fe20-fe2f 101fd 102e0 10376-1037a 10a0d 10a0f 10a38-10a3a " +
    "10a3f 10ae5-10ae6 10d24-10d27 10eab-10eac 10efd-10eff 10f46-10f50 10f82-10f85 11046 11070 1107f " +
    "110b9-110ba 11100-11102 11133-11134 11173 111c0 111ca 11235-11236 112e9-112ea 1133b-1133c 1134d " +
    "11366-1136c 11370-11374 11442 11446 1145e 114c2-114c3 115bf-115c0 1163f 116b6-116b7 1172b " +
    "11839-1183a 1193d-1193e 11943 119e0 11a34 11a47 11a99 11c3f 11d42 11d44-11d45 11d97 11f41-11f42 " +
    "16af0-16af4 16b30-16b36 16ff0-16ff1 1bc9e 1d165-1d169 1d16d-1d172 1d17b-1d182 1d185-1d18b " +
    "1d1aa-1d1ad 1d242-1d244 1e000-1e006 1e008-1e018 1e01b-1e021 1e023-1e024 1e026-1e02a 1e08f " +
    "1e130-1e136 1e2ae 1e2ec-1e2ef 1e4ec-1e4ef 1e8d0-1e8d6 1e944-1e94a",
);

/** `str.casefold()` là où il diffère de `str.lower()` (Unicode 15.1) : `code:cible.cible…` en hexadécimal. */
const REPLIS_TEXTE =
  "b5:3bc df:73.73 149:2bc.6e 17f:73 1f0:6a.30c 345:3b9 390:3b9.308.301 3b0:3c5.308.301 3c2:3c3 3d0:3b2 " +
  "3d1:3b8 3d5:3c6 3d6:3c0 3f0:3ba 3f1:3c1 3f5:3b5 587:565.582 13a0:13a0 13a1:13a1 13a2:13a2 13a3:13a3 " +
  "13a4:13a4 13a5:13a5 13a6:13a6 13a7:13a7 13a8:13a8 13a9:13a9 13aa:13aa 13ab:13ab 13ac:13ac 13ad:13ad " +
  "13ae:13ae 13af:13af 13b0:13b0 13b1:13b1 13b2:13b2 13b3:13b3 13b4:13b4 13b5:13b5 13b6:13b6 13b7:13b7 " +
  "13b8:13b8 13b9:13b9 13ba:13ba 13bb:13bb 13bc:13bc 13bd:13bd 13be:13be 13bf:13bf 13c0:13c0 13c1:13c1 " +
  "13c2:13c2 13c3:13c3 13c4:13c4 13c5:13c5 13c6:13c6 13c7:13c7 13c8:13c8 13c9:13c9 13ca:13ca 13cb:13cb " +
  "13cc:13cc 13cd:13cd 13ce:13ce 13cf:13cf 13d0:13d0 13d1:13d1 13d2:13d2 13d3:13d3 13d4:13d4 13d5:13d5 " +
  "13d6:13d6 13d7:13d7 13d8:13d8 13d9:13d9 13da:13da 13db:13db 13dc:13dc 13dd:13dd 13de:13de 13df:13df " +
  "13e0:13e0 13e1:13e1 13e2:13e2 13e3:13e3 13e4:13e4 13e5:13e5 13e6:13e6 13e7:13e7 13e8:13e8 13e9:13e9 " +
  "13ea:13ea 13eb:13eb 13ec:13ec 13ed:13ed 13ee:13ee 13ef:13ef 13f0:13f0 13f1:13f1 13f2:13f2 13f3:13f3 " +
  "13f4:13f4 13f5:13f5 13f8:13f0 13f9:13f1 13fa:13f2 13fb:13f3 13fc:13f4 13fd:13f5 1c80:432 1c81:434 " +
  "1c82:43e 1c83:441 1c84:442 1c85:442 1c86:44a 1c87:463 1c88:a64b 1e96:68.331 1e97:74.308 1e98:77.30a " +
  "1e99:79.30a 1e9a:61.2be 1e9b:1e61 1e9e:73.73 1f50:3c5.313 1f52:3c5.313.300 1f54:3c5.313.301 " +
  "1f56:3c5.313.342 1f80:1f00.3b9 1f81:1f01.3b9 1f82:1f02.3b9 1f83:1f03.3b9 1f84:1f04.3b9 1f85:1f05.3b9 " +
  "1f86:1f06.3b9 1f87:1f07.3b9 1f88:1f00.3b9 1f89:1f01.3b9 1f8a:1f02.3b9 1f8b:1f03.3b9 1f8c:1f04.3b9 " +
  "1f8d:1f05.3b9 1f8e:1f06.3b9 1f8f:1f07.3b9 1f90:1f20.3b9 1f91:1f21.3b9 1f92:1f22.3b9 1f93:1f23.3b9 " +
  "1f94:1f24.3b9 1f95:1f25.3b9 1f96:1f26.3b9 1f97:1f27.3b9 1f98:1f20.3b9 1f99:1f21.3b9 1f9a:1f22.3b9 " +
  "1f9b:1f23.3b9 1f9c:1f24.3b9 1f9d:1f25.3b9 1f9e:1f26.3b9 1f9f:1f27.3b9 1fa0:1f60.3b9 1fa1:1f61.3b9 " +
  "1fa2:1f62.3b9 1fa3:1f63.3b9 1fa4:1f64.3b9 1fa5:1f65.3b9 1fa6:1f66.3b9 1fa7:1f67.3b9 1fa8:1f60.3b9 " +
  "1fa9:1f61.3b9 1faa:1f62.3b9 1fab:1f63.3b9 1fac:1f64.3b9 1fad:1f65.3b9 1fae:1f66.3b9 1faf:1f67.3b9 " +
  "1fb2:1f70.3b9 1fb3:3b1.3b9 1fb4:3ac.3b9 1fb6:3b1.342 1fb7:3b1.342.3b9 1fbc:3b1.3b9 1fbe:3b9 " +
  "1fc2:1f74.3b9 1fc3:3b7.3b9 1fc4:3ae.3b9 1fc6:3b7.342 1fc7:3b7.342.3b9 1fcc:3b7.3b9 1fd2:3b9.308.300 " +
  "1fd3:3b9.308.301 1fd6:3b9.342 1fd7:3b9.308.342 1fe2:3c5.308.300 1fe3:3c5.308.301 1fe4:3c1.313 " +
  "1fe6:3c5.342 1fe7:3c5.308.342 1ff2:1f7c.3b9 1ff3:3c9.3b9 1ff4:3ce.3b9 1ff6:3c9.342 1ff7:3c9.342.3b9 " +
  "1ffc:3c9.3b9 ab70:13a0 ab71:13a1 ab72:13a2 ab73:13a3 ab74:13a4 ab75:13a5 ab76:13a6 ab77:13a7 " +
  "ab78:13a8 ab79:13a9 ab7a:13aa ab7b:13ab ab7c:13ac ab7d:13ad ab7e:13ae ab7f:13af ab80:13b0 ab81:13b1 " +
  "ab82:13b2 ab83:13b3 ab84:13b4 ab85:13b5 ab86:13b6 ab87:13b7 ab88:13b8 ab89:13b9 ab8a:13ba ab8b:13bb " +
  "ab8c:13bc ab8d:13bd ab8e:13be ab8f:13bf ab90:13c0 ab91:13c1 ab92:13c2 ab93:13c3 ab94:13c4 ab95:13c5 " +
  "ab96:13c6 ab97:13c7 ab98:13c8 ab99:13c9 ab9a:13ca ab9b:13cb ab9c:13cc ab9d:13cd ab9e:13ce ab9f:13cf " +
  "aba0:13d0 aba1:13d1 aba2:13d2 aba3:13d3 aba4:13d4 aba5:13d5 aba6:13d6 aba7:13d7 aba8:13d8 aba9:13d9 " +
  "abaa:13da abab:13db abac:13dc abad:13dd abae:13de abaf:13df abb0:13e0 abb1:13e1 abb2:13e2 abb3:13e3 " +
  "abb4:13e4 abb5:13e5 abb6:13e6 abb7:13e7 abb8:13e8 abb9:13e9 abba:13ea abbb:13eb abbc:13ec abbd:13ed " +
  "abbe:13ee abbf:13ef fb00:66.66 fb01:66.69 fb02:66.6c fb03:66.66.69 fb04:66.66.6c fb05:73.74 " +
  "fb06:73.74 fb13:574.576 fb14:574.565 fb15:574.56b fb16:57e.576 fb17:574.56d";

const REPLIS: ReadonlyMap<number, string> = new Map(
  REPLIS_TEXTE.split(" ").map((e) => {
    const [code = "", cibles = ""] = e.split(":");
    return [
      Number.parseInt(code, 16),
      String.fromCodePoint(...cibles.split(".").map((c) => Number.parseInt(c, 16))),
    ];
  }),
);

/** Segments normalisés par Node, coupés aux points de code non assignés en 15.1 (gardés tels quels, comme Python 3.13). */
function normaliser(s: string, forme: "NFC" | "NFKD"): string {
  let sortie = "";
  let debut = 0;
  let i = 0;
  for (const c of s) {
    if (!dans(ASSIGNES_15, c.codePointAt(0) ?? 0)) {
      sortie += s.slice(debut, i).normalize(forme) + c;
      debut = i + c.length;
    }
    i += c.length;
  }
  return sortie + s.slice(debut).normalize(forme);
}

/** `unicodedata.normalize("NFC", s)` de Python 3.13. */
export function nfcPy(s: string): string {
  return normaliser(s, "NFC");
}

/** NFKD puis retrait des marques combinantes (`unicodedata.combining`) : `_strip_accents` des skills. */
export function sansAccentsPy(s: string): string {
  let sortie = "";
  for (const c of normaliser(s, "NFKD")) if (!dans(COMBINANTS_15, c.codePointAt(0) ?? 0)) sortie += c;
  return sortie;
}

/** `lower()` d'un segment sans repli particulier : le sigma final de JS redevient σ (casefold ne connaît pas ς). */
function minuscules(s: string): string {
  return lowerPy(s).replaceAll("ς", "σ");
}

/** `str.casefold()` de Python 3.13 (repli complet, sans contexte). */
export function casefoldPy(s: string): string {
  let sortie = "";
  let debut = 0;
  let i = 0;
  for (const c of s) {
    const repli = REPLIS.get(c.codePointAt(0) ?? 0);
    if (repli !== undefined) {
      sortie += minuscules(s.slice(debut, i)) + repli;
      debut = i + c.length;
    }
    i += c.length;
  }
  return sortie + minuscules(s.slice(debut));
}
