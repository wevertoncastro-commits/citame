"""
Citame - Gestor Acadêmico de PDFs e Referências
===============================================================
Aplicação Streamlit inspirada no Zotero e Mendeley para pesquisadores,
doutorandos e acadêmicos.

Funcionalidades:
- Armazenamento local de PDFs e metadados
- Extração de metadados de PDFs (Título, Autores, Ano, DOI)
- Catálogo e busca avançada por coleções e palavras-chave
- Geração instantânea de citações e referências ABNT (NBR 6023) e APA (7ª Ed.)
- Abertura dos arquivos mantidos na biblioteca local
"""

import os
import re
import io
import streamlit as st
import pandas as pd
from pypdf import PdfReader

# Importação dos módulos do sistema
import db_manager as db
import citation_generator as cite

# Configuração da página Streamlit
st.set_page_config(
    page_title="Citame | Gestor Acadêmico",
    page_icon="📚",
    layout="wide",
    initial_sidebar_state="expanded"
)
# Inicializa o banco de dados na inicialização
db.init_db()


def extract_metadata_from_pdf(uploaded_file) -> dict:
    """
    Lê a primeira página e metadados internos do PDF para extrair:
    - Título provável
    - Autores
    - Ano de publicação
    - DOI
    """
    extracted = {
        'title': '',
        'authors': '',
        'publication_year': 2024,
        'journal': '',
        'doi': '',
        'abstract': ''
    }

    try:
        reader = PdfReader(uploaded_file)
        # Metadados internos do documento PDF
        doc_info = reader.metadata
        if doc_info:
            if doc_info.title and len(doc_info.title.strip()) > 3:
                extracted['title'] = doc_info.title.strip()
            if doc_info.author and len(doc_info.author.strip()) > 2:
                extracted['authors'] = doc_info.author.strip()

        # Extração de texto da primeira página
        if len(reader.pages) > 0:
            first_page_text = reader.pages[0].extract_text() or ""

            # Busca por DOI via regex
            doi_match = re.search(r'(10\.\d{4,9}/[-._;()/:A-Za-z0-9]+)', first_page_text)
            if doi_match:
                extracted['doi'] = doi_match.group(1).rstrip('.')

            # Busca por ano de publicação provável (entre 1970 e 2026)
            year_matches = re.findall(r'\b(19\d\d|20[0-2]\d)\b', first_page_text)
            if year_matches:
                # Pega o ano mais recente razoável
                valid_years = [int(y) for y in year_matches if 1980 <= int(y) <= 2026]
                if valid_years:
                    extracted['publication_year'] = max(valid_years)

            # Heurística de título: primeiras linhas com texto representativo se o PDF metadata não tiver
            if not extracted['title']:
                lines = [line.strip() for line in first_page_text.split('\n') if len(line.strip()) > 15]
                if lines:
                    extracted['title'] = lines[0]

            # Heurística de resumo (abstract)
            abstract_match = re.search(r'(?:Abstract|Resumo)[\s\:\-]+(.+?)(?:Keywords|Palavras-chave|1\.|Introduction|Introdução)', first_page_text, re.DOTALL | re.IGNORECASE)
            if abstract_match:
                extracted['abstract'] = abstract_match.group(1).strip()[:500]

    except Exception as e:
        st.warning(f"Aviso na extração de texto do PDF: {e}")

    # Fallback se título ainda estiver vazio
    if not extracted['title']:
        extracted['title'] = uploaded_file.name.replace('.pdf', '').replace('_', ' ').replace('-', ' ').title()

    return extracted


# ==============================================================================
# BARRA LATERAL (SIDEBAR)
# ==============================================================================
with st.sidebar:
    st.title("📚 Citame")
    st.caption("Gestor Acadêmico Local de Referências")
    st.markdown("---")

    # Navegação por Coleções
    st.subheader("📁 Coleções")
    collections_data = db.get_all_collections()
    collection_names = ["Todas"] + [c['name'] for c in collections_data]
    
    selected_collection = st.selectbox(
        "Filtrar por Coleção:",
        collection_names,
        index=0
    )

    # Criar Nova Coleção
    with st.expander("➕ Nova Coleção"):
        new_col_name = st.text_input("Nome da Coleção", placeholder="Ex: Matriz C.H.A.")
        new_col_desc = st.text_area("Descrição (opcional)", placeholder="Objetivo da coleção...")
        if st.button("Criar Coleção"):
            if new_col_name.strip():
                if db.add_collection(new_col_name, new_col_desc):
                    st.success(f"Coleção '{new_col_name}' criada!")
                    st.rerun()
                else:
                    st.error("Coleção já existe ou nome inválido.")

    # Estatísticas da Biblioteca
    st.markdown("---")
    stats = db.get_catalog_stats()
    st.markdown("📊 **Estatísticas**")
    col_s1, col_s2 = st.columns(2)
    col_s1.metric("Artigos", stats['total_articles'])
    col_s2.metric("Coleções", stats['total_collections'])


# ==============================================================================
# ÁREA PRINCIPAL COM ABAS (TABS)
# ==============================================================================
tab_catalog, tab_upload, tab_batch_cite = st.tabs([
    "📖 Catálogo de Referências",
    "📤 Novo Upload & Extração",
    "📑 Gerador de Citações em Lote"
])


# ------------------------------------------------------------------------------
# ABA 1: CATÁLOGO DE REFERÊNCIAS
# ------------------------------------------------------------------------------
with tab_catalog:
    col_search, col_filter_type = st.columns([3, 1])
    with col_search:
        search_query = st.text_input("🔍 Buscar por Título, Autor, DOI, Revista ou Tags:", placeholder="Digite para filtrar...")
    with col_filter_type:
        st.write("")
        st.write("")
        st.caption(f"Coleção ativa: **{selected_collection}**")

    # Obter dados do banco
    items = db.get_all_references(
        collection=selected_collection if selected_collection != 'Todas' else None,
        search_term=search_query
    )

    if not items:
        st.info("Nenhuma referência encontrada para os filtros selecionados. Faça o upload de um artigo na aba 'Novo Upload'.")
    else:
        st.write(f"Exibindo **{len(items)}** referência(s):")

        for item in items:
            with st.container(border=True):
                c_main, c_actions = st.columns([4, 1.2])

                with c_main:
                    st.subheader(item['title'])
                    st.markdown(f"**Autores:** {item['authors']} | **Ano:** {item['publication_year'] or 's.d.'} | **Coleção:** `{item['collection']}`")
                    
                    if item.get('journal'):
                        meta_details = f"**Periódico:** *{item['journal']}*"
                        if item.get('volume'): meta_details += f", v. {item['volume']}"
                        if item.get('issue'): meta_details += f", n. {item['issue']}"
                        if item.get('pages'): meta_details += f", p. {item['pages']}"
                        st.markdown(meta_details)

                    if item.get('doi'):
                        doi_clean = item['doi'] if item['doi'].startswith('http') else f"https://doi.org/{item['doi']}"
                        st.markdown(f"🔗 **DOI:** [{item['doi']}]({doi_clean})")

                    if item.get('tags'):
                        tags_list = [t.strip() for t in item['tags'].split(',') if t.strip()]
                        tags_badges = " ".join([f"`{t}`" for t in tags_list])
                        st.markdown(f"🏷️ {tags_badges}")

                with c_actions:
                    local_path = os.path.join("Citame-Biblioteca", "Citame-Artigo", item.get('filename', ''))
                    if item.get('url'):
                        st.link_button("🔗 Abrir URL", item['url'], use_container_width=True)
                    elif item.get('filename') and os.path.exists(local_path):
                        with open(local_path, "rb") as local_file:
                            st.download_button("📂 Abrir arquivo local", local_file.read(), file_name=item['filename'], use_container_width=True)
                    else:
                        st.caption("PDF salvo localmente")

                    # Botão para expandir citações
                    with st.popover("📜 Ver Citações", use_container_width=True):
                        st.markdown("#### Norma ABNT (NBR 6023)")
                        abnt_text = cite.format_abnt(item)
                        st.markdown(abnt_text)
                        st.code(abnt_text.replace('*', ''), language="text")

                        st.markdown("#### Norma APA (7ª Edição)")
                        apa_text = cite.format_apa(item)
                        st.markdown(apa_text)
                        st.code(apa_text.replace('*', ''), language="text")

                        st.markdown("#### Citação no Texto")
                        in_text = cite.format_in_text(item)
                        st.markdown(f"**ABNT:** `{in_text['abnt_parenthetical']}` ou `{in_text['abnt_narrative']}`")
                        st.markdown(f"**APA:** `{in_text['apa_parenthetical']}` ou `{in_text['apa_narrative']}`")

                    # Botão Excluir
                    if st.button("🗑️ Excluir", key=f"del_{item['id']}", use_container_width=True):
                        db.delete_reference(item['id'])
                        st.success("Referência excluída!")
                        st.rerun()


# ------------------------------------------------------------------------------
# ABA 2: NOVO UPLOAD E EXTRAÇÃO DE METADADOS
# ------------------------------------------------------------------------------
with tab_upload:
    st.header("📤 Upload de Artigo e Extração Automática")
    st.write("Faça o upload do seu artigo em PDF. Os metadados serão extraídos automaticamente e o arquivo será preservado na biblioteca local.")

    uploaded_file = st.file_uploader("Selecione o arquivo PDF:", type=["pdf"])

    if uploaded_file is not None:
        file_bytes = uploaded_file.read()
        
        # Extração automática
        with st.spinner("Analisando o documento PDF e extraindo metadados..."):
            extracted = extract_metadata_from_pdf(io.BytesIO(file_bytes))

        st.success("Metadados extraídos com sucesso! Revise ou complete os campos abaixo antes de salvar:")

        with st.form("form_article_metadata"):
            col_f1, col_f2 = st.columns([3, 1])
            with col_f1:
                title_input = st.text_input("Título do Artigo *", value=extracted['title'])
            with col_f2:
                year_input = st.number_input("Ano de Publicação", min_value=1900, max_value=2030, value=int(extracted['publication_year']))

            authors_input = st.text_input("Autores (Separados por ponto e vírgula)", value=extracted['authors'], placeholder="Ex: Silva, João; Santos, Maria")

            col_j1, col_j2, col_j3, col_j4 = st.columns([2, 1, 1, 1])
            with col_j1:
                journal_input = st.text_input("Revista / Periódico", value=extracted['journal'], placeholder="Ex: Revista Brasileira de Pós-Graduação")
            with col_j2:
                volume_input = st.text_input("Volume", placeholder="Ex: 18")
            with col_j3:
                issue_input = st.text_input("Número / Fascículo", placeholder="Ex: 2")
            with col_j4:
                pages_input = st.text_input("Páginas", placeholder="Ex: 45-60")

            col_d1, col_d2 = st.columns(2)
            with col_d1:
                doi_input = st.text_input("DOI", value=extracted['doi'], placeholder="Ex: 10.1016/j.respol.2023.104821")
            with col_d2:
                collections_available = [c['name'] for c in db.get_all_collections()]
                collection_input = st.selectbox("Coleção / Pasta", collections_available)

            tags_input = st.text_input("Palavras-chave / Tags (separadas por vírgula)", placeholder="Ex: Metodologia, Doutorado, Neurociência, C.H.A.")
            abstract_input = st.text_area("Resumo (Abstract)", value=extracted['abstract'], height=100)

            submitted = st.form_submit_button("💾 Salvar na Biblioteca Local")

            if submitted:
                if not title_input.strip():
                    st.error("O campo Título é obrigatório!")
                else:
                    article_folder = os.path.join("Citame-Biblioteca", "Citame-Artigo")
                    os.makedirs(article_folder, exist_ok=True)
                    local_filename = uploaded_file.name
                    with open(os.path.join(article_folder, local_filename), "wb") as local_file:
                        local_file.write(file_bytes)

                    # Salva no banco de dados SQLite
                    new_ref_id = db.insert_reference({
                        'title': title_input,
                        'authors': authors_input,
                        'publication_year': year_input,
                        'journal': journal_input,
                        'volume': volume_input,
                        'issue': issue_input,
                        'pages': pages_input,
                        'doi': doi_input,
                        'url': '',
                        'abstract': abstract_input,
                        'tags': tags_input,
                        'collection': collection_input,
                        'doc_type': 'Artigo de Periódico',
                        'filename': local_filename
                    })

                    st.balloons()
                    st.success(f"Artigo salvo com sucesso! (ID: {new_ref_id})")


# ------------------------------------------------------------------------------
# ABA 3: GERADOR DE CITAÇÕES EM LOTE (REFERÊNCIAS DA TESE)
# ------------------------------------------------------------------------------
with tab_batch_cite:
    st.header("📑 Gerador de Bibliografia para Tese / Dissertação")
    st.write("Gere a lista completa de referências formatadas em **ABNT** ou **APA** prontas para colar no seu trabalho acadêmico.")

    col_b1, col_b2 = st.columns([2, 1])
    with col_b1:
        target_collection = st.selectbox("Selecione a Coleção para exportação:", ["Todas"] + [c['name'] for c in db.get_all_collections()], key="batch_col")
    with col_b2:
        citation_standard = st.radio("Norma Bibliográfica:", ["ABNT (NBR 6023:2018)", "APA (7ª Edição)"])

    all_items = db.get_all_references(collection=target_collection if target_collection != 'Todas' else None)

    if not all_items:
        st.info("Nenhuma referência nesta seleção.")
    else:
        st.write(f"Total de itens: **{len(all_items)}**")

        # Gerar referências
        if citation_standard.startswith("ABNT"):
            citations_list = [cite.format_abnt(item) for item in all_items]
        else:
            citations_list = [cite.format_apa(item) for item in all_items]

        # Ordenar alfabeticamente pelo autor
        citations_list.sort()
        full_text = "\n\n".join(citations_list)

        st.text_area("Lista de Referências Formatadas (Copie abaixo):", value=full_text, height=300)

        col_exp1, col_exp2 = st.columns(2)
        with col_exp1:
            # Exportar BibTeX
            bibtex_data = "\n\n".join([cite.export_bibtex(item) for item in all_items])
            st.download_button(
                label="📥 Baixar como arquivo BibTeX (.bib)",
                data=bibtex_data,
                file_name="referencias_tese.bib",
                mime="text/plain"
            )

        with col_exp2:
            # Exportar RIS
            ris_data = "\n\n".join([cite.export_ris(item) for item in all_items])
            st.download_button(
                label="📥 Baixar como arquivo RIS (.ris)",
                data=ris_data,
                file_name="referencias_tese.ris",
                mime="text/plain"
            )

