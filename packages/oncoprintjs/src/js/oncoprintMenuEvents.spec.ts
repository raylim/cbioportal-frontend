import $ from 'jquery';
import OncoprintHeaderView from './oncoprintheaderview';
import OncoprintTrackOptionsView from './oncoprinttrackoptionsview';
import {
    HEADER_VIEW_CLOSE_MENUS_EVENT,
    TRACK_OPTIONS_VIEW_CLOSE_MENUS_EVENT,
} from './oncoprintMenuEvents';

describe('oncoprint menu close events', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        $.fx.off = true;
    });

    afterEach(() => {
        $(document).off(HEADER_VIEW_CLOSE_MENUS_EVENT);
        $(document).off(TRACK_OPTIONS_VIEW_CLOSE_MENUS_EVENT);
        $(document).off('click');
        $.fx.off = false;
    });

    it('header closeDropdownsExcept closes sibling menus and notifies track options', () => {
        const $container = $('<div/>')
            .css({ position: 'relative' })
            .appendTo(document.body);
        const view = new OncoprintHeaderView($container);

        const $keepOpen = $('<div/>')
            .css({ display: 'block' })
            .appendTo(document.body);
        const $closeMe = $('<div/>')
            .css({ display: 'block' })
            .appendTo(document.body);

        (view as any).$dropdowns = [$keepOpen, $closeMe];

        const trackOptionsCloseSpy = jest.fn();
        $(document).on(
            TRACK_OPTIONS_VIEW_CLOSE_MENUS_EVENT,
            trackOptionsCloseSpy
        );

        (view as any).closeDropdownsExcept($keepOpen);

        expect($keepOpen.css('display')).toBe('block');
        expect($closeMe.css('display')).toBe('none');
        expect(trackOptionsCloseSpy).toHaveBeenCalledTimes(1);

        view.destroy();
    });

    it('track hideMenusExcept closes sibling menus and notifies the header view', () => {
        const $container = $('<div/>')
            .css({ position: 'relative' })
            .appendTo(document.body);
        const view = new OncoprintTrackOptionsView(
            $container,
            jest.fn(),
            jest.fn(),
            jest.fn(),
            jest.fn(),
            jest.fn(),
            jest.fn()
        );

        const makeTrackElements = () => ({
            $div: $('<div/>').appendTo(document.body),
            $img: $('<div/>').appendTo(document.body),
            $dropdown: $('<div/>')
                .css({ display: 'block' })
                .appendTo(document.body),
        });

        (view as any).track_options_$elts = {
            1: makeTrackElements(),
            2: makeTrackElements(),
        };
        (view as any).menu_shown = { 1: true, 2: true };

        const headerCloseSpy = jest.fn();
        $(document).on(HEADER_VIEW_CLOSE_MENUS_EVENT, headerCloseSpy);

        (view as any).hideMenusExcept(1);

        expect((view as any).track_options_$elts[1].$dropdown.css('display')).toBe(
            'block'
        );
        expect((view as any).track_options_$elts[2].$dropdown.css('display')).toBe(
            'none'
        );
        expect(headerCloseSpy).toHaveBeenCalledTimes(1);

        view.destroy();
    });
});
