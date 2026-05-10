export {
	defineA2uiComponent,
	type DefineA2uiComponentOptions,
	type A2uiComponentHandle,
	type A2uiProperties,
	type ActionRegistration
} from './define-component.svelte';
export { default as A2UIRepresentation, A2UI_REPRESENTATION_KEY } from './A2UIRepresentation.svelte';
export {
	type Catalog,
	setCatalog,
	getCatalog,
	createCatalog,
	extendCatalog
} from './catalog';
export { DEFAULT_CATALOG } from '../components/default-catalog';
