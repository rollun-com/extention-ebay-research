window.onload = main;
const rollunAPI = axios.create({
    baseURL: 'https://rollun.net',
    headers: {
        'Authorization': 'Basic MTE2OTg0MDk5MDM3MTI0MzU2NTY2Ojlxak5JdGZo',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
});

function setupShortcuts() {
    window.e = React.createElement;
    window.useState = React.useState;
}

function main() {
    setupShortcuts();

    const mountContainer = document.querySelectorAll('header')[1];
    const mountElement = document.createElement('div');
    mountElement.id = 'ebay-chrome-extension';
    insertAfter(mountContainer.firstElementChild, mountElement);

    ReactDOM.render(e(Control), mountElement);
}

function Control() {
    const [ data, setData ] = useState(null);
    const [ progress, setProgress ] = useState(null);

    async function selectCategory(category) {
        document
          .querySelector('.category-selector-panel__edit-button')
          ?.click();

        Array
          .from(
            document.querySelectorAll('[role="tree"] [role="treeitem"] .category-selection-row__category-name-value')
          )
          .find(({ innerText }) => new RegExp(category, 'ig').test(innerText))
          ?.click();

        document
          .querySelector('.category-selection-lightbox-dialog__footer-apply')
          ?.click();

        await wait(4000)
    }

    async function runSearch(searchString) {
        // insert input value
        const inputQ = '.textbox__control';
        const input = document.querySelector(inputQ);
        input.value = searchString;

        input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

        await wait(150);
        // trigger search
        const searchBtnQ = '.search-input-panel__research-button';
        const searchBtn = document.querySelector(searchBtnQ);
        searchBtn.click();

        await wait(4000);
    }

    async function getDataToResearch(limit) {
        const { data } = await rollunAPI.get('/api/datastore/EbayResearchRequests?eqn(parsed_at)');
        return data
          .sort((data1, data2) => {
            const [, date1] = data1.id.split('#');
            const [, date2] = data2.id.split('#');

            return new Date(date1) - new Date(date2);
          })
          .map(({ id }) => ({ id, input: id.split('#')[0] }))
          .slice(0, limit ?? data.length)
    }

    function isListingFoundInSearch() {
        const errorContainer = document.querySelector('.sold-tab-content .research__generic-error');
        return !errorContainer;
    }

    async function selectTab(tabName) {
        const [tabToSelect] = [...document.querySelector('.tabs__items').children]
          .filter(({ innerText }) => innerText.trim() === tabName);

        console.log(tabToSelect);
        if (!tabToSelect) {
            // if no tab is found, just ignore
            return;
        }

        tabToSelect.click();
        await wait(3000);
    }

    function selectFilter(filterName) {
        const [filterElement] = [...document.querySelectorAll('.research-table-header__inner-item > .text')]
          .filter((item) => item.innerText === filterName);
        const filterDownElement = filterElement?.parentElement.querySelector('.down');

        if (!filterDownElement) {
            filterElement?.click();
        }
    }

    function filterItems(items, rules) {
        return items.filter((item) => rules.every((rule) => rule(item)))
    }

    async function handleStart() {
        console.log('HI');
        const dataToResearch = await getDataToResearch(500);
        setData(dataToResearch);

        for (let idx = 0; idx < dataToResearch.length; idx++) {
            const { id, input } = dataToResearch[idx];
            try {
                setProgress({ text: `handling ${idx} input of total ${dataToResearch.length}` });
                await runSearch(input);

                if (!isListingFoundInSearch()) {
                    await writeResearchRequestToDatastore({ id, parsed_at: formatDate(new Date()) });
                    continue;
                }

                await selectCategory('ebay motors');
                await selectFilter('Total sold');
                await selectTab('Sold');
                const stats = parseStats(input, id);
                const items = filterItems(
                  await parseAllItems(stats.id),
                  filterRules
                ).map((item) => ({
                    ...item,
                    mpn: item.mpn.replaceAll('*', ''),
                }));
                console.log('items', items);
                console.log('stats', stats);

                await writeResearchResultsToDatastore(items);
                await writeResearchRequestToDatastore(stats);
            } catch (e) {
                console.log(e.stack);
                alert(`Could not parse item - ${id}. ${e.message}`);
            }
        }
        setProgress({ text: `Finished parsing ${dataToResearch.length} inputs` });
    }

    async function writeResearchResultsToDatastore(items) {
        // spit items into chunks
        const chunks = [];
        for (let i = 0; i < items.length; i += 100) {
            chunks.push(items.slice(i, i + 100));
        }

        for (const chunk of chunks) {
            await rollunAPI.post('/api/datastore/EbayResearchResults', chunk);
        }
    }
    async function writeResearchRequestToDatastore(stats) {
        await rollunAPI.put('/api/datastore/EbayResearchRequests', stats, {
            // headers: {
            //     'If-Match': '*'
            // }
        });
    }

    function getStatsFromMetricContainer(container) {
        const parseStrategy = {
            avg_sold_price: dollarStringParser,
            avg_shipping: dollarStringParser,
            total_sales: dollarStringParser,
            free_shipping: percentStringParser,
            sell_through: percentStringParser,
            total_sold: numberStringParser,
            total_sellers: numberStringParser,
            sold_price_range: (value) => {
                const [min, max] = value.split('???');
                return {
                    sold_price_min: castDollarStringToNumber(min.trim()),
                    sold_price_max: castDollarStringToNumber(max.trim()),
                }
            }
        }

        return Array.from(container.querySelectorAll('.aggregate-metric')).reduce((acc, curr) => {
            const value = curr.querySelector('.metric-value').innerText.trim();
            const header = curr.querySelector('.metric-title').innerText.trim();
            const snakeCaseHeader = toSnakeCase(header);

            if (!(snakeCaseHeader in parseStrategy)) {
                return acc;
            }

            return {
                ...acc,
                ...(parseStrategy[snakeCaseHeader](value, snakeCaseHeader)),
            }
        }, {})
    }

    async function parseAllItems(statId) {
        const result = [];
        const isValidListingToParse = (item) => {
            if (!item) {
                return true;
            }

            return item.total_sold > 5;
        }

        while (isValidOffset() && isValidListingToParse(result.at(-1))) {
            const nextPageButton = document.querySelector('button.pagination__next');
            const isNextPageButtonDisabled = nextPageButton?.getAttribute('aria-disabled') === 'true';

            result.push(...await parseItemsList(statId));
            console.log(result);
            if (!nextPageButton || isNextPageButtonDisabled) {
                break;
            }

            nextPageButton.click();
            await wait(4000);
        }

        return result;
    }

    function isValidOffset() {
        const errorText = document.querySelector('.page-notice__title');
        return !errorText?.innerText?.includes('The offset provided is incorrect. Please correct the offset.');
    }

    function parseStats(input, id) {
        const metricsContainer = document.querySelector('.aggregates');
        const currentDate = formatDate(new Date())
        const result = {
            id, parsed_at: currentDate
        }

        if (!metricsContainer) {
            return result;
        }

        const stats = getStatsFromMetricContainer(metricsContainer);

        return {
            ...result,
            input,
            ...stats,
        };
    }


    async function parseItemsList(statId) {
        const rows = document.querySelectorAll('.research-table-row');

        async function getMpn(id) {
            const htmlPage = await (await fetch(`https://www.ebay.com/itm/${id}?nordt=true&orig_cvip=true&rt=nc`)).text();
            const doc = new DOMParser().parseFromString(htmlPage, 'text/html');

            const mpnLabelIndex = [...doc.querySelectorAll('.ux-labels-values__labels')].findIndex((item) => item.innerText === 'Manufacturer Part Number:');
            if (mpnLabelIndex === -1) {
                return null;
            }

            return doc.querySelectorAll('.ux-labels-values__values')[mpnLabelIndex]?.innerText?.trim() || null;
        }

        async function parseRow(row) {
            const linkWrapper = row.querySelector('.research-table-row__product-info-name');
            const linkEl = linkWrapper.querySelector('a');
            const link = linkEl?.href || null;

            const titleEl = linkWrapper.querySelector('span');
            const id = titleEl.dataset.itemId;
            const title = titleEl.innerText;

            const avgPriceEl = row.querySelector('.research-table-row__avgSoldPrice');
            const price = castDollarStringToNumber(avgPriceEl.firstElementChild.firstElementChild.innerText);

            const avgShippingCostEl = row.querySelector('.research-table-row__avgShippingCost');
            const shipPrice = castDollarStringToNumber(avgShippingCostEl.firstElementChild.firstElementChild.innerText);

            const totalSoldEl = row.querySelector('.research-table-row__totalSoldCount');

            const lastDateSoldText = row.querySelector('.research-table-row__dateLastSold')?.innerText;
            const lastDateSold = lastDateSoldText ? formatDate(new Date(lastDateSoldText)) : null;

            const totalSalesText = row.querySelector('.research-table-row__totalSalesValue')?.innerText;
            const totalSales = castDollarStringToNumber(totalSalesText);

            const currentDate = formatDate(new Date());

            return {
                listing_id: id,
                title,
                link,
                avg_sold_price: price,
                avg_shipping: shipPrice,
                total_sold: +totalSoldEl.innerText,
                total_sales: totalSales,
                last_date_sold: lastDateSold,
                parsed_at: currentDate,
                request_id: statId,
                mpn: await getMpn(id),
            };
        }

        return Promise.all(Array.from(rows).map(parseRow));
    }

    return e('div', {},
        !progress && e('button', { onClick: handleStart }, 'start'),
        progress && e('div', {}, progress.text),
        data && e('div', {}, `Loaded ${data.length} input(s)`),
    );
}

