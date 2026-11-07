package __PACKAGE__;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BmPlugin.class);
        super.onCreate(savedInstanceState);
        // A képernyő ne aludjon el, amíg az app előtérben van (olvasás közben)
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
