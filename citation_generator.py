"""
Módulo Gerador de Citações e Referências Bibliográficas
======================================================
Formatador rigoroso para normas acadêmicas:
1. ABNT (Associação Brasileira de Normas Técnicas - NBR 6023:2018)
2. APA (American Psychological Association - 7ª Edição)
3. Citações no texto (Direta e Indireta)
4. Exportação em BibTeX e RIS (compatível com Zotero, Mendeley e EndNote)
"""

import re
from typing import Dict, Any, List


def _parse_authors(authors_str: str) -> List[Dict[str, str]]:
    """
    Interpreta uma string com nomes de autores e separa em Sobrenome e Prenomes.
    Aceita separação por ponto e vírgula ou vírgula:
    Exemplos:
    - 'Silva, João Carlos; Santos, Maria Eduarda'
    - 'João Carlos Silva and Maria Eduarda Santos'
    - 'Silva, J. C.'
    """
    if not authors_str or not authors_str.strip():
        return [{'last': 'AUTOR DESCONHECIDO', 'first': '', 'initials': ''}]

    authors_str = authors_str.replace(' and ', '; ').replace(' e ', '; ')
    raw_list = [a.strip() for a in authors_str.split(';') if a.strip()]

    parsed = []
    for item in raw_list:
        if ',' in item:
            parts = item.split(',', 1)
            last = parts[0].strip()
            first = parts[1].strip()
        else:
            words = item.split()
            if len(words) == 1:
                last = words[0]
                first = ""
            else:
                last = words[-1]
                first = " ".join(words[:-1])

        # Gera iniciais (ex: "J. C.")
        first_words = [w for w in re.split(r'[\s\.\-]+', first) if w]
        initials = ". ".join([w[0].upper() for w in first_words]) + ("." if first_words else "")

        parsed.append({
            'last': last,
            'first': first,
            'initials': initials
        })

    return parsed if parsed else [{'last': 'AUTOR DESCONHECIDO', 'first': '', 'initials': ''}]


def format_abnt(ref: Dict[str, Any]) -> str:
    """
    Formata referência segundo a ABNT NBR 6023:2018.
    Regra: SOBRENOME, Prenome(s). Título do artigo: subtítulo. Nome da Revista,
    Local, v. X, n. Y, p. inicial-final, ano. DOI: 10.xxxx ou Disponível em: <url>.
    """
    authors = _parse_authors(ref.get('authors', ''))
    title = ref.get('title', 'Sem título').strip()
    journal = ref.get('journal', '').strip()
    year = ref.get('publication_year', '')
    volume = ref.get('volume', '').strip()
    issue = ref.get('issue', '').strip()
    pages = ref.get('pages', '').strip()
    doi = ref.get('doi', '').strip()
    url = ref.get('url', '').strip()
    doc_type = ref.get('doc_type', 'Artigo de Periódico')

    # Autores ABNT
    # Se até 3 autores: SOBRENOME, Nome; SOBRENOME2, Nome2; SOBRENOME3, Nome3.
    # Se mais de 3 autores: SOBRENOME, Nome et al. (ou todos, mas et al. é padrão acadêmico)
    if len(authors) <= 3:
        authors_formatted = "; ".join([f"{a['last'].upper()}, {a['first'] or a['initials']}" for a in authors])
    else:
        first = authors[0]
        authors_formatted = f"{first['last'].upper()}, {first['first'] or first['initials']} et al."

    # Se for livro vs artigo
    if doc_type == 'Livro':
        # Livro: SOBRENOME, Nome. Título em negrito: subtítulo. Edição. Local: Editora, ano.
        citation = f"{authors_formatted}. **{title}**."
        if journal:
            citation += f" {journal},"
        if year:
            citation += f" {year}."
    else:
        # Artigo de Periódico: Título normal, Periódico em negrito
        citation = f"{authors_formatted}. {title}."
        if journal:
            citation += f" **{journal}**"
        if volume:
            citation += f", v. {volume}"
        if issue:
            citation += f", n. {issue}"
        if pages:
            citation += f", p. {pages}"
        if year:
            citation += f", {year}."
        else:
            citation += "."

    if doi:
        clean_doi = doi if doi.startswith('http') else f"https://doi.org/{doi}"
        citation += f" DOI: {clean_doi}."
    elif url:
        citation += f" Disponível em: <{url}>."

    return citation.strip()


def format_apa(ref: Dict[str, Any]) -> str:
    """
    Formata referência segundo a APA 7ª Edição.
    Regra: Author, A. A., & Author, B. B. (Year). Title of article. Title of Periodical,
    volume(issue), pages. https://doi.org/xx.xxx
    """
    authors = _parse_authors(ref.get('authors', ''))
    title = ref.get('title', 'Untitled').strip()
    journal = ref.get('journal', '').strip()
    year = ref.get('publication_year', 'n.d.')
    volume = ref.get('volume', '').strip()
    issue = ref.get('issue', '').strip()
    pages = ref.get('pages', '').strip()
    doi = ref.get('doi', '').strip()
    url = ref.get('url', '').strip()

    # Formatação de autores APA: Last, F. M., & Last, F. M.
    formatted_authors_list = []
    for a in authors:
        last = a['last'].capitalize()
        initials = a['initials'] or (a['first'][0].upper() + "." if a['first'] else "")
        formatted_authors_list.append(f"{last}, {initials}".strip())

    if len(formatted_authors_list) == 1:
        authors_str = formatted_authors_list[0]
    elif len(formatted_authors_list) == 2:
        authors_str = f"{formatted_authors_list[0]}, & {formatted_authors_list[1]}"
    elif len(formatted_authors_list) <= 20:
        authors_str = ", ".join(formatted_authors_list[:-1]) + f", & {formatted_authors_list[-1]}"
    else:
        authors_str = ", ".join(formatted_authors_list[:19]) + f", ... {formatted_authors_list[-1]}"

    # Monta referência APA
    citation = f"{authors_str} ({year}). {title}."

    if journal:
        journal_part = f" *{journal}*"
        if volume:
            journal_part += f", *{volume}*"
            if issue:
                journal_part += f"({issue})"
        if pages:
            journal_part += f", {pages}"
        citation += f"{journal_part}."

    if doi:
        clean_doi = doi if doi.startswith('http') else f"https://doi.org/{doi}"
        citation += f" {clean_doi}"
    elif url:
        citation += f" {url}"

    return citation.strip()


def format_in_text(ref: Dict[str, Any]) -> Dict[str, str]:
    """
    Gera as citações no texto para ABNT e APA.
    Retorna as formas parentética e narrativa:
    - ABNT: (SILVA, 2023) / Silva (2023)
    - APA: (Silva, 2023) / Silva (2023)
    """
    authors = _parse_authors(ref.get('authors', ''))
    year = str(ref.get('publication_year', 's.d.'))

    # ABNT Parentética
    if len(authors) == 1:
        abnt_paren = f"({authors[0]['last'].upper()}, {year})"
        abnt_narr = f"{authors[0]['last'].capitalize()} ({year})"
    elif len(authors) == 2:
        abnt_paren = f"({authors[0]['last'].upper()}; {authors[1]['last'].upper()}, {year})"
        abnt_narr = f"{authors[0]['last'].capitalize()} e {authors[1]['last'].capitalize()} ({year})"
    elif len(authors) == 3:
        abnt_paren = f"({authors[0]['last'].upper()}; {authors[1]['last'].upper()}; {authors[2]['last'].upper()}, {year})"
        abnt_narr = f"{authors[0]['last'].capitalize()}, {authors[1]['last'].capitalize()} e {authors[2]['last'].capitalize()} ({year})"
    else:
        abnt_paren = f"({authors[0]['last'].upper()} et al., {year})"
        abnt_narr = f"{authors[0]['last'].capitalize()} et al. ({year})"

    # APA Parentética
    if len(authors) == 1:
        apa_paren = f"({authors[0]['last'].capitalize()}, {year})"
        apa_narr = f"{authors[0]['last'].capitalize()} ({year})"
    elif len(authors) == 2:
        apa_paren = f"({authors[0]['last'].capitalize()} & {authors[1]['last'].capitalize()}, {year})"
        apa_narr = f"{authors[0]['last'].capitalize()} and {authors[1]['last'].capitalize()} ({year})"
    else:
        apa_paren = f"({authors[0]['last'].capitalize()} et al., {year})"
        apa_narr = f"{authors[0]['last'].capitalize()} et al. ({year})"

    return {
        'abnt_parenthetical': abnt_paren,
        'abnt_narrative': abnt_narr,
        'apa_parenthetical': apa_paren,
        'apa_narrative': apa_narr
    }


def export_bibtex(ref: Dict[str, Any]) -> str:
    """Gera a entrada BibTeX para o artigo."""
    authors = _parse_authors(ref.get('authors', ''))
    first_author_last = re.sub(r'[^a-zA-Z]', '', authors[0]['last'].lower())
    year = ref.get('publication_year', 2024)
    cite_key = f"{first_author_last}{year}"

    # BibTeX authors: Last, First and Last2, First2
    bibtex_authors = " and ".join([f"{a['last']}, {a['first'] or a['initials']}" for a in authors])

    entry_type = "article" if ref.get('doc_type') != 'Livro' else "book"

    lines = [
        f"@{entry_type}{{{cite_key},",
        f"  title = {{{ref.get('title', '')}}},",
        f"  author = {{{bibtex_authors}}},",
        f"  year = {{{year}}},"
    ]
    if ref.get('journal'):
        lines.append(f"  journal = {{{ref.get('journal')}}},")
    if ref.get('volume'):
        lines.append(f"  volume = {{{ref.get('volume')}}},")
    if ref.get('issue'):
        lines.append(f"  number = {{{ref.get('issue')}}},")
    if ref.get('pages'):
        lines.append(f"  pages = {{{ref.get('pages')}}},")
    if ref.get('doi'):
        lines.append(f"  doi = {{{ref.get('doi')}}},")
    if ref.get('url'):
        lines.append(f"  url = {{{ref.get('url')}}},")
    lines.append("}")

    return "\n".join(lines)


def export_ris(ref: Dict[str, Any]) -> str:
    """Gera formato RIS para importação direta em Zotero, Mendeley e EndNote."""
    authors = _parse_authors(ref.get('authors', ''))
    lines = ["TY  - JOUR"]

    for a in authors:
        lines.append(f"AU  - {a['last']}, {a['first'] or a['initials']}")

    lines.append(f"TI  - {ref.get('title', '')}")
    if ref.get('journal'):
        lines.append(f"JO  - {ref.get('journal')}")
    if ref.get('publication_year'):
        lines.append(f"PY  - {ref.get('publication_year')}")
    if ref.get('volume'):
        lines.append(f"VL  - {ref.get('volume')}")
    if ref.get('issue'):
        lines.append(f"IS  - {ref.get('issue')}")
    if ref.get('pages'):
        lines.append(f"SP  - {ref.get('pages')}")
    if ref.get('doi'):
        lines.append(f"DO  - {ref.get('doi')}")
    if ref.get('url'):
        lines.append(f"UR  - {ref.get('url')}")
    if ref.get('abstract'):
        lines.append(f"AB  - {ref.get('abstract')}")
    lines.append("ER  - ")

    return "\n".join(lines)
