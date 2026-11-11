# Server data files

| File | What it is | Source | Used by |
|---|---|---|---|
| `breached-passwords.txt` | 46,146 passwords of 12 to 64 characters that appear in public leaks, lower-cased, sorted, one per line | The 1,000,000 most common passwords of the xato.net leak compilation, from [SecLists](https://github.com/danielmiessler/SecLists) (`Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt`, MIT licence), keeping only the entries the policy would otherwise accept (12 characters or more, IAM-03) | `src/modules/identity/infrastructure/breached-list.ts` |

To rebuild the list:

```sh
curl -sSfL -o xato.txt https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt
LC_ALL=C awk 'length($0)>=12 && length($0)<=64' xato.txt | tr 'A-Z' 'a-z' | LC_ALL=C sort -u > breached-passwords.txt
```
