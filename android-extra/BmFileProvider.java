package __PACKAGE__;

import androidx.core.content.FileProvider;

/** Saját FileProvider-alosztály: így nem ütközik a Capacitor beépített providerével. */
public class BmFileProvider extends FileProvider {
}
